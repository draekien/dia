// @effect-diagnostics *:off
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Exit, Fiber, Layer, PubSub, Ref, Scope, Stream } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'

type Report = { readonly task: string; readonly [key: string]: unknown }

const send = (message: Report): void => {
  if (process.parentPort !== undefined) process.parentPort.postMessage(message)
  else if (process.send !== undefined) process.send(message)
  else console.log(JSON.stringify(message))
}

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

const fixtureRoot = mkdtempSync(join(tmpdir(), 'dia-spike-'))

const writeGeneration = (dir: string, generation: number): string => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
  writeFileSync(join(dir, 'dep.ts'), `export const dep: number = ${generation}\n`)
  writeFileSync(
    join(dir, 'plugin.ts'),
    `import { dep } from './dep'\ninterface Version { plugin: number; dep: number }\nexport const version: Version = { plugin: ${generation}, dep }\n`
  )
  return pathToFileURL(join(dir, 'plugin.ts')).href
}

const attempt = async (
  task: string,
  run: () => Promise<Record<string, unknown>>
): Promise<void> => {
  try {
    send({ task, ok: true, ...(await run()) })
  } catch (error) {
    send({ task, ok: false, error: errorText(error) })
  }
}

const loaderTask = () =>
  attempt('loader', async () => {
    const url = writeGeneration(join(fixtureRoot, 'loader'), 1)
    const mod = await import(url)
    return { version: mod.version }
  })

const cacheBustEntryOnly = () =>
  attempt('evict:query-string-entry-only', async () => {
    const dir = join(fixtureRoot, 'query')
    const first = await import(`${writeGeneration(dir, 1)}?v=1`)
    const second = await import(`${writeGeneration(dir, 2)}?v=2`)
    return { before: first.version, after: second.version }
  })

const cacheBustWholeGraph = () =>
  attempt('evict:registerHooks-generation', async () => {
    const dir = join(fixtureRoot, 'hooks')
    const rootUrl = pathToFileURL(dir).href
    let generation = 1
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context)
        if (!resolved.url.startsWith(rootUrl)) return resolved
        return { ...resolved, url: `${resolved.url.split('?')[0]}?gen=${generation}` }
      }
    })
    const url = writeGeneration(dir, 1)
    const first = await import(url)
    writeGeneration(dir, 2)
    generation = 2
    const second = await import(url)
    hooks.deregister()
    return { before: first.version, after: second.version }
  })

const tsxImport = () =>
  attempt('evict:tsImport', async () => {
    const { tsImport } = await import('tsx/esm/api')
    const dir = join(fixtureRoot, 'tsimport')
    const url = writeGeneration(dir, 1)
    const first = await tsImport(url, import.meta.url)
    writeGeneration(dir, 2)
    const second = await tsImport(url, import.meta.url)
    return { before: first.version, after: second.version }
  })

const internalsEviction = () =>
  attempt('evict:expose-internals-loadCache', async () => {
    const require = createRequire(import.meta.url)
    const { getOrInitializeCascadedLoader } = require('internal/modules/esm/loader')
    const loader = getOrInitializeCascadedLoader()
    const dir = join(fixtureRoot, 'internals')
    const url = writeGeneration(dir, 1)
    const first = await import(url)
    writeGeneration(dir, 2)
    const evicted: Array<string> = []
    for (const key of Map.prototype.keys.call(loader.loadCache)) {
      if (typeof key === 'string' && key.startsWith(pathToFileURL(dir).href)) evicted.push(key)
    }
    for (const key of evicted) Map.prototype.delete.call(loader.loadCache, key)
    const second = await import(url)
    return { before: first.version, after: second.version, evicted }
  })

const resolveClaudeExecutable = (): string | undefined => {
  const ext = process.platform === 'win32' ? '.exe' : ''
  try {
    return createRequire(import.meta.url)
      .resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`)
      .replace(`app.asar${'\\'}`, `app.asar.unpacked${'\\'}`)
      .replace('app.asar/', 'app.asar.unpacked/')
  } catch {
    return undefined
  }
}

const pollAtLeast = (ref: Ref.Ref<number>, target: number) =>
  Effect.gen(function* () {
    while ((yield* Ref.get(ref)) < target) yield* Effect.sleep('20 millis')
  })

const kernelQueryTask = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<SDKMessage>()
  const kernelCount = yield* Ref.make(0)
  const executable = resolveClaudeExecutable()
  const session = query({
    prompt: 'Count from 1 to 400 in words, separated by commas. Output nothing else.',
    options: {
      cwd: fixtureRoot,
      model: 'haiku',
      maxTurns: 1,
      includePartialMessages: true,
      settingSources: [],
      ...(executable !== undefined ? { pathToClaudeCodeExecutable: executable } : {})
    }
  })
  const kernel = yield* Stream.fromAsyncIterable(session, (cause) => cause).pipe(
    Stream.runForEach((message) =>
      Ref.update(kernelCount, (n) => n + 1).pipe(Effect.andThen(PubSub.publish(events, message)))
    ),
    Effect.forkChild
  )

  const openPlugin = Effect.gen(function* () {
    const scope = yield* Scope.make()
    const seen = yield* Ref.make(0)
    const firstKernelIndex = yield* Ref.get(kernelCount)
    const subscription = yield* PubSub.subscribe(events).pipe(Scope.provide(scope))
    const subscriber = yield* Effect.forever(
      PubSub.take(subscription).pipe(Effect.andThen(Ref.update(seen, (n) => n + 1)))
    ).pipe(Effect.forkIn(scope))
    return { scope, seen, subscriber, firstKernelIndex }
  })

  const first = yield* openPlugin
  yield* pollAtLeast(first.seen, 20)
  yield* Scope.close(first.scope, Exit.void)
  const kernelAtClose = yield* Ref.get(kernelCount)
  const firstSeenAtClose = yield* Ref.get(first.seen)
  const firstSubscriberDone = first.subscriber.pollUnsafe() !== undefined

  yield* Effect.sleep('500 millis')
  const second = yield* openPlugin
  yield* pollAtLeast(second.seen, 20)
  yield* Scope.close(second.scope, Exit.void)

  const kernelExit = yield* Fiber.await(kernel)
  return {
    kernelAtClose,
    kernelAtReopen: second.firstKernelIndex,
    kernelTotal: yield* Ref.get(kernelCount),
    firstSeenAtClose,
    firstSeenAfterKernelEnd: yield* Ref.get(first.seen),
    firstSubscriberDone,
    secondSeen: yield* Ref.get(second.seen),
    kernelExit: Exit.isSuccess(kernelExit) ? 'success' : String(kernelExit.cause)
  }
})

const queryTask = () => attempt('query', () => Effect.runPromise(Effect.scoped(kernelQueryTask)))

const tokenProtocolPrefix = 'dia.token.'

const wsTask = (): void => {
  const token = randomBytes(32).toString('hex')
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const offered = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
    if (!offered.includes(`${tokenProtocolPrefix}${token}`)) {
      return HttpServerResponse.text('missing or wrong token', { status: 401 })
    }
    const socket = yield* request.upgrade
    yield* Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* socket.reader
        const writer = yield* socket.writer
        return yield* Effect.forever(
          reader.pull.pipe(
            Effect.flatMap((batch) =>
              Effect.forEach(batch, (chunk) => writer.write(`echo:${chunk}`))
            )
          )
        )
      })
    ).pipe(Effect.ignore)
    return HttpServerResponse.empty()
  })

  const program = Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const address = server.address
    send({
      task: 'ws:listening',
      ok: true,
      address: address._tag,
      port: 'port' in address ? address.port : -1,
      token
    })
    return yield* Effect.never
  })

  Effect.runFork(
    program.pipe(
      Effect.provide(
        HttpServer.serve()(app).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(() => createServer(), { host: '127.0.0.1', port: 0 })
          )
        )
      ),
      Effect.tapCause((cause) =>
        Effect.sync(() => send({ task: 'ws:listening', ok: false, error: String(cause) }))
      )
    )
  )
}

const main = async (): Promise<void> => {
  const tasks = (process.env.SPIKE_TASKS ?? 'loader,evict').split(',')
  send({
    task: 'hello',
    ok: true,
    versions: process.versions.node,
    execArgv: process.execArgv,
    parentPort: process.parentPort !== undefined,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1'
  })
  if (tasks.includes('tsx-api')) {
    const { register } = await import('tsx/esm/api')
    register()
    send({ task: 'tsx-api:registered', ok: true })
  }
  if (tasks.includes('loader')) await loaderTask()
  if (tasks.includes('evict')) {
    await cacheBustEntryOnly()
    await cacheBustWholeGraph()
    await tsxImport()
    if (process.execArgv.includes('--expose-internals')) await internalsEviction()
  }
  if (tasks.includes('query')) await queryTask()
  if (tasks.includes('ws')) wsTask()
  else send({ task: 'done', ok: true })
}

void main()

import { type DiaTool, diaTool, type ToolScope } from '@dia/plugin'
import { hashToken, type Tools } from '@dia-plugin/dia-tools/tools'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Option, Schema, Scope } from 'effect'
import { makeRunTools } from './run-tools'

const URL = 'http://127.0.0.1:4100/mcp'
const RUN = { runId: 'run-1', project: '/work/dia', labels: [], context: { issueId: 'i-1' } }
const OUTSIDE: ToolScope = { labels: [], context: undefined }

const pluginReload = diaTool({
  name: 'plugin_reload',
  description: 'Reload a plugin.',
  input: Schema.Struct({ name: Schema.String }),
  run: () => Effect.succeed({ text: 'ok', isError: false })
})

const fakeTools = () => {
  const registered: Array<{ tool: DiaTool; when: (scope: ToolScope) => boolean }> = []
  const grants = new Map<string, ToolScope>()
  const tools: Tools = {
    register: (tool, options) =>
      Effect.acquireRelease(
        Effect.sync(() => registered.push({ tool, when: options.when })),
        () => Effect.sync(() => registered.splice(0))
      ).pipe(Effect.asVoid),
    forScope: (scope) =>
      Effect.sync(() => registered.filter((entry) => entry.when(scope)).map((e) => e.tool)),
    grant: (hash, scope) => Effect.sync(() => void grants.set(hash, scope)),
    revoke: (hash) => Effect.sync(() => void grants.delete(hash)),
    url: URL,
    mcpServer: () => Effect.die('not used')
  }
  return { tools, grants }
}

const tokenOf = (options: Option.Option<{ readonly mcpServers: Record<string, unknown> }>) => {
  const server = Option.getOrThrow(options).mcpServers.dia as {
    readonly url: string
    readonly headers: { readonly Authorization: string }
  }
  return { url: server.url, token: server.headers.Authorization.replace('Bearer ', '') }
}

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeCrypto.layer))

describe('run tools', () => {
  it.effect('registers the plugin tools for runs and not for outside agents', () =>
    Effect.gen(function* () {
      const runTools = yield* provided(makeRunTools)
      const fake = fakeTools()

      yield* runTools.follow(fake.tools, [pluginReload])

      const forRun = yield* fake.tools.forScope(RUN)
      const forOutside = yield* fake.tools.forScope(OUTSIDE)
      assert.deepStrictEqual(
        forRun.map((tool) => tool.name),
        ['plugin_reload']
      )
      assert.deepStrictEqual(forOutside, [])
    }).pipe(Effect.scoped)
  )

  it.effect("gives a run the dia HTTP server with a token granted the run's scope", () =>
    Effect.gen(function* () {
      const runTools = yield* provided(makeRunTools)
      const fake = fakeTools()
      yield* runTools.follow(fake.tools, [])

      const { url, token } = tokenOf(yield* runTools.sessionTools(RUN))

      assert.strictEqual(url, URL)
      assert.deepStrictEqual(fake.grants.get(yield* provided(hashToken(token))), RUN)
    }).pipe(Effect.scoped)
  )

  it.effect("revokes the run's token when the run's scope closes", () =>
    Effect.gen(function* () {
      const runTools = yield* provided(makeRunTools)
      const fake = fakeTools()
      yield* runTools.follow(fake.tools, [])
      const runScope = yield* Scope.make()

      const options = yield* runTools.sessionTools(RUN).pipe(Scope.provide(runScope))
      yield* Scope.close(runScope, Exit.void)

      const hash = yield* provided(hashToken(tokenOf(options).token))
      assert.isFalse(fake.grants.has(hash))
    }).pipe(Effect.scoped)
  )

  it.effect('grants a live run again to a registry that is provided after it opened', () =>
    Effect.gen(function* () {
      const runTools = yield* provided(makeRunTools)
      const first = fakeTools()
      const firstScope = yield* Scope.make()
      yield* runTools.follow(first.tools, []).pipe(Scope.provide(firstScope))
      const { token } = tokenOf(yield* runTools.sessionTools(RUN))
      yield* Scope.close(firstScope, Exit.void)
      const second = fakeTools()

      yield* runTools.follow(second.tools, [])

      assert.deepStrictEqual(second.grants.get(yield* provided(hashToken(token))), RUN)
    }).pipe(Effect.scoped)
  )

  it.effect('gives a run no dia server while no registry is provided', () =>
    Effect.gen(function* () {
      const runTools = yield* provided(makeRunTools)

      const options = yield* runTools.sessionTools(RUN)

      assert.isTrue(Option.isNone(options))
    }).pipe(Effect.scoped)
  )
})

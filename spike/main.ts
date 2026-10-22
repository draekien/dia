// @effect-diagnostics *:off
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, utilityProcess } from 'electron'

type Kind = 'utility' | 'runAsNode'

interface Variant {
  readonly name: string
  readonly kind: Kind
  readonly execArgv: ReadonlyArray<string>
  readonly tasks: string
  readonly env?: Record<string, string>
  readonly until?: string
  readonly timeoutMs?: number
}

interface Run {
  readonly variant: string
  readonly messages: Array<unknown>
  stdout: string
  stderr: string
  exitCode: number | null | 'timeout' | 'still-running'
}

type HostHandle = { readonly kill: () => void }

const unpacked = (path: string): string => path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

const require = createRequire(import.meta.url)
const tsxLoaderPath = require.resolve('tsx')
const esbuildBinaryPath = unpacked(
  require.resolve(
    `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`,
    {
      paths: [require.resolve('esbuild')]
    }
  )
)
const hostPath = join(import.meta.dirname, 'spike-host.js')

const startHost = (
  variant: Variant,
  onMessage: (message: unknown) => void,
  run: Run,
  onExit: (code: number | null) => void
): HostHandle => {
  const env = { ...process.env, SPIKE_TASKS: variant.tasks, ...variant.env }
  if (variant.kind === 'utility') {
    const child = utilityProcess.fork(hostPath, [], {
      execArgv: [...variant.execArgv],
      env,
      stdio: 'pipe'
    })
    child.stdout?.on('data', (chunk) => (run.stdout += String(chunk)))
    child.stderr?.on('data', (chunk) => (run.stderr += String(chunk)))
    child.on('message', onMessage)
    child.on('exit', onExit)
    return { kill: () => child.kill() }
  }
  const child = spawn(process.execPath, [...variant.execArgv, hostPath], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  child.stdout?.on('data', (chunk) => (run.stdout += String(chunk)))
  child.stderr?.on('data', (chunk) => (run.stderr += String(chunk)))
  child.on('message', onMessage)
  child.on('exit', onExit)
  child.on('error', (error) => run.messages.push({ task: 'spawn-error', error: String(error) }))
  return { kill: () => child.kill() }
}

const isTask = (message: unknown, task: string): boolean =>
  typeof message === 'object' && message !== null && 'task' in message && message.task === task

const runVariant = (
  variant: Variant,
  onEachMessage?: (message: unknown, host: HostHandle) => Promise<void>
): Promise<Run> =>
  new Promise((resolve) => {
    const run: Run = {
      variant: variant.name,
      messages: [],
      stdout: '',
      stderr: '',
      exitCode: 'still-running'
    }
    const until = variant.until ?? 'done'
    let settled = false
    const finish = (code: Run['exitCode']): void => {
      if (settled) return
      settled = true
      run.exitCode = code
      host.kill()
      resolve(run)
    }
    const host: HostHandle = startHost(
      variant,
      (message) => {
        run.messages.push(message)
        if (onEachMessage !== undefined) {
          void onEachMessage(message, host).then(() => {
            if (isTask(message, until)) finish('still-running')
          })
        } else if (isTask(message, until)) finish('still-running')
      },
      run,
      (code) => finish(code)
    )
    setTimeout(() => finish('timeout'), variant.timeoutMs ?? 60_000)
  })

const rendererProbe = (port: number, token: string): string => `
(async () => {
  const attempt = (protocols) => new Promise((resolve) => {
    const socket = new WebSocket('ws://127.0.0.1:${port}/', protocols)
    const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 5000)
    socket.onopen = () => socket.send('ping')
    socket.onmessage = (event) => { clearTimeout(timer); resolve({ outcome: 'open', echo: event.data, protocol: socket.protocol }); socket.close() }
    socket.onclose = (event) => { clearTimeout(timer); resolve({ outcome: 'closed', code: event.code }) }
  })
  return {
    origin: location.href,
    withToken: await attempt(['dia.token.${token}']),
    noToken: await attempt([]),
    wrongToken: await attempt(['dia.token.${'0'.repeat(64)}'])
  }
})()
`

const probeFromRenderer = async (port: number, token: string): Promise<unknown> => {
  const dir = mkdtempSync(join(tmpdir(), 'dia-spike-page-'))
  const page = join(dir, 'index.html')
  writeFileSync(page, '<!doctype html><html><body>spike</body></html>')
  const window = new BrowserWindow({ show: false })
  await window.loadFile(page)
  return window.webContents.executeJavaScript(rendererProbe(port, token))
}

const readListening = (message: unknown): { port: number; token: string } | undefined => {
  if (!isTask(message, 'ws:listening') || typeof message !== 'object' || message === null)
    return undefined
  if (!('port' in message) || !('token' in message)) return undefined
  return typeof message.port === 'number' && typeof message.token === 'string'
    ? { port: message.port, token: message.token }
    : undefined
}

/** Runs the Phase 0 plugin platform spike and writes its results as JSON, then quits. */
export const runSpike = async (): Promise<void> => {
  const tsxUrl = pathToFileURL(tsxLoaderPath).href
  const tsxUnpackedUrl = pathToFileURL(unpacked(tsxLoaderPath)).href
  const esbuildEnv = { ESBUILD_BINARY_PATH: esbuildBinaryPath }
  const variants: Array<Variant> = [
    {
      name: 'utility --import tsx(asar path)',
      kind: 'utility',
      execArgv: ['--import', tsxUrl],
      tasks: 'loader,evict'
    },
    {
      name: 'utility --import tsx(asar path) +ESBUILD_BINARY_PATH',
      kind: 'utility',
      execArgv: ['--import', tsxUrl],
      tasks: 'loader,evict',
      env: esbuildEnv
    },
    {
      name: 'utility --import tsx(unpacked path) +ESBUILD_BINARY_PATH',
      kind: 'utility',
      execArgv: ['--import', tsxUnpackedUrl],
      tasks: 'loader',
      env: esbuildEnv
    },
    {
      name: 'utility --expose-internals --import tsx +ESBUILD_BINARY_PATH',
      kind: 'utility',
      execArgv: ['--expose-internals', '--import', tsxUrl],
      tasks: 'evict',
      env: esbuildEnv
    },
    {
      name: 'utility programmatic tsx register() +ESBUILD_BINARY_PATH',
      kind: 'utility',
      execArgv: [],
      tasks: 'tsx-api,loader,evict',
      env: esbuildEnv
    },
    {
      name: 'utility --expose-internals programmatic tsx register() +ESBUILD_BINARY_PATH',
      kind: 'utility',
      execArgv: ['--expose-internals'],
      tasks: 'tsx-api,evict',
      env: esbuildEnv
    },
    {
      name: 'runAsNode --import tsx(asar path)',
      kind: 'runAsNode',
      execArgv: ['--import', tsxUrl],
      tasks: 'loader,evict'
    },
    {
      name: 'runAsNode --import tsx(asar path) +ESBUILD_BINARY_PATH',
      kind: 'runAsNode',
      execArgv: ['--import', tsxUrl],
      tasks: 'loader,evict',
      env: esbuildEnv
    },
    {
      name: 'runAsNode --expose-internals --import tsx +ESBUILD_BINARY_PATH',
      kind: 'runAsNode',
      execArgv: ['--expose-internals', '--import', tsxUrl],
      tasks: 'evict',
      env: esbuildEnv
    }
  ]
  const skipQuery = process.env.SPIKE_SKIP_QUERY === '1'
  const runs: Array<unknown> = []
  for (const variant of variants) runs.push(await runVariant(variant))

  runs.push(
    await runVariant(
      {
        name: 'utility ws handshake',
        kind: 'utility',
        execArgv: [],
        tasks: 'ws',
        until: 'ws:listening'
      },
      async (message) => {
        const listening = readListening(message)
        if (listening === undefined) return
        const probe = await probeFromRenderer(listening.port, listening.token).catch(
          (error: unknown) => ({
            error: error instanceof Error ? error.message : JSON.stringify(error)
          })
        )
        runs.push({ variant: 'renderer probe', probe })
      }
    )
  )

  if (!skipQuery) {
    runs.push(
      await runVariant({
        name: 'utility kernel query',
        kind: 'utility',
        execArgv: [],
        tasks: 'query',
        timeoutMs: 240_000
      })
    )
  }

  const out = process.env.SPIKE_OUT ?? join(app.getPath('temp'), 'dia-spike-results.json')
  writeFileSync(
    out,
    JSON.stringify(
      {
        packaged: app.isPackaged,
        electron: process.versions.electron,
        node: process.versions.node,
        tsxLoaderPath,
        esbuildBinaryPath,
        esbuildBinaryExists: existsSync(esbuildBinaryPath),
        hostPath,
        runs
      },
      null,
      2
    )
  )
  app.quit()
}

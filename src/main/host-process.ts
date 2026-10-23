// @effect-diagnostics-next-line nodeBuiltinImport:off -- composes the unpacked esbuild binary path from Electron's resourcesPath outside any Effect.
import { join } from 'node:path'
import type { HostConnection } from '@shared/ipc/contract'
import {
  type HostInit,
  HostShutdown,
  HostToMainMessage,
  MainToHostMessage
} from '@shared/ipc/host-process'
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef
} from 'effect'
import { type UtilityProcess, utilityProcess } from 'electron'

const encodeToHost = Schema.encodeSync(MainToHostMessage)
const decodeFromHost = Schema.decodeUnknownOption(HostToMainMessage)

const RESTART_DELAY = Duration.seconds(1)
const READY_TIMEOUT = Duration.seconds(30)
const SHUTDOWN_TIMEOUT = Duration.seconds(10)

/**
 * Handle on the supervised Host process returned by {@link startHostProcess}. `connection`
 * completes with the Host's current {@link HostConnection}, waiting while the Host is starting or
 * restarting. `shutdown` asks the Host to end every pane's session and exit, then kills it if it
 * does not within a timeout, and stops restarting it.
 */
export interface HostProcess {
  readonly connection: Effect.Effect<HostConnection>
  readonly shutdown: Effect.Effect<void>
}

/**
 * Path of the unpacked esbuild binary the Host's tsx loader needs in a packaged build, where
 * esbuild cannot run from inside `app.asar`. `undefined` when running unpackaged.
 */
export const resolveEsbuildBinaryPath = (isPackaged: boolean): string | undefined => {
  if (!isPackaged) return undefined
  const unpackedModules = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
  const platformPackage = join(unpackedModules, '@esbuild', `${process.platform}-${process.arch}`)
  return process.platform === 'win32'
    ? join(platformPackage, 'esbuild.exe')
    : join(platformPackage, 'bin', 'esbuild')
}

/**
 * Starts the Host as an Electron `utilityProcess` running `options.hostEntry`, hands it
 * `options.init` once it announces it is booted, and restarts it when it exits unexpectedly.
 * `onRestarted` runs after every restart once the new Host is ready, so the caller can make the
 * renderer reconnect to the new port and token. The returned {@link HostProcess} lives in the
 * surrounding scope.
 */
export const startHostProcess = Effect.fn('HostProcess.start')(function* (options: {
  readonly hostEntry: string
  readonly init: HostInit
  readonly esbuildBinaryPath: string | undefined
  readonly onRestarted: Effect.Effect<void>
}): Effect.fn.Return<HostProcess, never, Scope.Scope> {
  const connectionRef = yield* SubscriptionRef.make<Option.Option<HostConnection>>(Option.none())
  const childRef = yield* Ref.make<Option.Option<UtilityProcess>>(Option.none())
  const stoppingRef = yield* Ref.make(false)
  const shutdownComplete = yield* Deferred.make<void>()

  const runOnce = Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          utilityProcess.fork(options.hostEntry, [], {
            serviceName: 'dia-host',
            env: {
              ...process.env,
              ...(options.esbuildBinaryPath !== undefined
                ? { ESBUILD_BINARY_PATH: options.esbuildBinaryPath }
                : {})
            }
          })
        ),
        (live) => Effect.sync(() => live.kill())
      )
      yield* Ref.set(childRef, Option.some(child))

      const exited = yield* Deferred.make<number>()
      child.on('exit', (code) => void Effect.runFork(Deferred.succeed(exited, code)))

      const messages = yield* Queue.unbounded<HostToMainMessage>()
      child.on('message', (raw) => {
        const decoded = decodeFromHost(raw)
        if (Option.isSome(decoded)) Queue.offerUnsafe(messages, decoded.value)
      })

      const awaitMessage = <Tag extends HostToMainMessage['_tag']>(tag: Tag) =>
        Effect.gen(function* () {
          while (true) {
            const message = yield* Queue.take(messages)
            if (message._tag === tag) return message as Extract<HostToMainMessage, { _tag: Tag }>
          }
        })

      const handshake = Effect.gen(function* () {
        yield* awaitMessage('Booted')
        child.postMessage(encodeToHost(options.init))
        return yield* awaitMessage('Ready')
      }).pipe(Effect.timeout(READY_TIMEOUT))

      const ready = yield* handshake.pipe(Effect.option)
      if (Option.isNone(ready)) {
        yield* Effect.logError('Host did not become ready in time; killing it')
        child.kill()
        return yield* Deferred.await(exited)
      }

      yield* SubscriptionRef.set(
        connectionRef,
        Option.some({ port: ready.value.port, token: ready.value.token })
      )
      yield* Effect.logInfo('Host ready', { pid: child.pid, port: ready.value.port })

      const completion = yield* awaitMessage('ShutdownComplete').pipe(
        Effect.andThen(Deferred.succeed(shutdownComplete, undefined)),
        Effect.forkScoped
      )
      const code = yield* Deferred.await(exited)
      yield* Fiber.interrupt(completion)
      yield* SubscriptionRef.set(connectionRef, Option.none())
      return code
    })
  )

  const supervise = Effect.gen(function* () {
    let restarts = 0
    while (!(yield* Ref.get(stoppingRef))) {
      const code = yield* runOnce
      yield* Ref.set(childRef, Option.none())
      if (yield* Ref.get(stoppingRef)) return
      yield* Effect.logError('Host exited unexpectedly; restarting', { code })
      yield* Effect.sleep(RESTART_DELAY)
      restarts += 1
    }
    return restarts
  })

  const restartWatcher = SubscriptionRef.changes(connectionRef).pipe(
    Stream.filter(Option.isSome),
    Stream.zipWithIndex,
    Stream.filter(([, index]) => index > 0),
    Stream.runForEach(() => options.onRestarted)
  )

  yield* Effect.forkScoped(supervise)
  yield* Effect.forkScoped(restartWatcher)

  const connection = SubscriptionRef.changes(connectionRef).pipe(
    Stream.filter(Option.isSome),
    Stream.take(1),
    Stream.runHead,
    Effect.map((head) => Option.getOrThrow(Option.flatten(head)))
  )

  const shutdown = Effect.gen(function* () {
    yield* Ref.set(stoppingRef, true)
    const child = yield* Ref.get(childRef)
    if (Option.isNone(child)) return
    child.value.postMessage(encodeToHost(HostShutdown.make({})))
    yield* Deferred.await(shutdownComplete).pipe(
      Effect.timeout(SHUTDOWN_TIMEOUT),
      Effect.catch(() => Effect.logWarning('Host did not shut down in time; killing it'))
    )
    child.value.kill()
  })

  return { connection, shutdown }
})

import { createRequire } from 'node:module'
import type * as NodePty from '@lydell/node-pty'
import {
  Crypto,
  Deferred,
  Duration,
  Effect,
  Option,
  PubSub,
  Queue,
  type Scope,
  Semaphore,
  Stream,
  SubscriptionRef
} from 'effect'
import { shellCommand } from './shell'
import {
  TerminalExited,
  type TerminalInfo,
  TerminalOpenError,
  TerminalRunning,
  type Terminals
} from './terminals'

const RETAINED_CHARACTERS = 1024 * 1024
const START_COLS = 80
const START_ROWS = 24
const EXIT_WAIT = Duration.seconds(5)

type PtyEvent =
  | { readonly _tag: 'Data'; readonly data: string }
  | { readonly _tag: 'Exit'; readonly exitCode: number }

interface Terminal {
  readonly pty: NodePty.IPty
  readonly lock: Semaphore.Semaphore
  readonly chunks: Array<string>
  readonly published: PubSub.PubSub<Option.Option<string>>
  readonly ended: Deferred.Deferred<void>
  size: number
  running: boolean
}

const loadNodePty = (): typeof NodePty => {
  const require = createRequire(import.meta.url)
  const resolved = require.resolve('@lydell/node-pty')
  return require(resolved.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'))
}

const retain = (terminal: Terminal, data: string) => {
  const chunk = data.length > RETAINED_CHARACTERS ? data.slice(-RETAINED_CHARACTERS) : data
  terminal.chunks.push(chunk)
  terminal.size += chunk.length
  while (terminal.size > RETAINED_CHARACTERS) {
    terminal.size -= terminal.chunks.shift()?.length ?? 0
  }
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * The terminals of every run, as {@link Terminals}. `cwdOf` returns a run's working directory, or
 * none when the run is unknown or runs are not provided. Every process ends when the calling
 * scope closes.
 */
export const makeTerminals = Effect.fnUntraced(function* (
  cwdOf: (runId: string) => Effect.Effect<Option.Option<string>>
): Effect.fn.Return<Terminals, never, Scope.Scope | Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto
  const scope = yield* Effect.scope
  const infos = yield* SubscriptionRef.make<ReadonlyArray<TerminalInfo>>([])
  const terminals = new Map<string, Terminal>()
  let nodePty: typeof NodePty | undefined

  const processes = new Set<Terminal>()

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const ending = [...processes]
      for (const terminal of ending) terminal.pty.kill()
      terminals.clear()
      yield* Effect.forEach(ending, (terminal) => Deferred.await(terminal.ended), {
        concurrency: 'unbounded',
        discard: true
      }).pipe(Effect.timeout(EXIT_WAIT), Effect.ignore)
      yield* Effect.logInfo('Terminals closed', { processes: ending.length })
    })
  )

  const setInfo = (terminalId: string, info: Option.Option<TerminalInfo>) =>
    SubscriptionRef.update(infos, (current) =>
      Option.match(info, {
        onNone: () => current.filter((each) => each.terminalId !== terminalId),
        onSome: (next) => current.map((each) => (each.terminalId === terminalId ? next : each))
      })
    )

  const infoOf = (terminalId: string) =>
    Effect.map(SubscriptionRef.get(infos), (current) =>
      Option.fromUndefinedOr(current.find((each) => each.terminalId === terminalId))
    )

  const handle = (terminalId: string, terminal: Terminal, event: PtyEvent) =>
    terminal.lock.withPermits(1)(
      Effect.gen(function* () {
        if (event._tag === 'Data') {
          retain(terminal, event.data)
          yield* PubSub.publish(terminal.published, Option.some(event.data))
          return
        }
        terminal.running = false
        yield* PubSub.publish(terminal.published, Option.none())
        const info = yield* infoOf(terminalId)
        if (Option.isNone(info)) return
        yield* setInfo(
          terminalId,
          Option.some(
            TerminalExited.make({
              terminalId,
              runId: info.value.runId,
              title: info.value.title,
              exitCode: event.exitCode
            })
          )
        )
        yield* Effect.logInfo('Terminal exited', {
          terminalId,
          runId: info.value.runId,
          exitCode: event.exitCode
        })
      })
    )

  const spawn = (cwd: string, command: string | undefined) =>
    Effect.try({
      try: () => {
        // @effect-diagnostics-next-line processEnvInEffect:off -- a terminal starts the user's login shell, as one opened outside dia would.
        const shell = shellCommand(process.platform, process.env.SHELL, command)
        nodePty ??= loadNodePty()
        const pty = nodePty.spawn(shell.file, [...shell.args], {
          name: 'xterm-256color',
          cols: START_COLS,
          rows: START_ROWS,
          cwd,
          env: process.env
        })
        return { pty, title: shell.title }
      },
      catch: describe
    })

  const open = Effect.fn('Terminals.open')(function* (runId: string, command?: string) {
    const cwd = yield* cwdOf(runId)
    if (Option.isNone(cwd)) {
      return yield* new TerminalOpenError({ runId, message: 'No run has this id.' })
    }
    const { pty, title } = yield* spawn(cwd.value, command).pipe(
      Effect.mapError((message) => new TerminalOpenError({ runId, message }))
    )
    const terminalId = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
    const terminal: Terminal = {
      pty,
      lock: yield* Semaphore.make(1),
      chunks: [],
      published: yield* PubSub.unbounded<Option.Option<string>>(),
      ended: yield* Deferred.make<void>(),
      size: 0,
      running: true
    }
    const events = yield* Queue.unbounded<PtyEvent>()
    pty.onData((data) => Queue.offerUnsafe(events, { _tag: 'Data', data }))
    pty.onExit(({ exitCode }) => {
      processes.delete(terminal)
      Deferred.doneUnsafe(terminal.ended, Effect.void)
      Queue.offerUnsafe(events, { _tag: 'Exit', exitCode })
    })
    terminals.set(terminalId, terminal)
    processes.add(terminal)
    const info = TerminalRunning.make({ terminalId, runId, title })
    yield* SubscriptionRef.update(infos, (current) => [...current, info])
    yield* Stream.fromQueue(events).pipe(
      Stream.takeUntil((event) => event._tag === 'Exit'),
      Stream.runForEach((event) => handle(terminalId, terminal, event)),
      Effect.forkIn(scope)
    )
    yield* Effect.logInfo('Terminal opened', { terminalId, runId, title })
    return info
  })

  const list = (runId: string) =>
    SubscriptionRef.changes(infos).pipe(
      Stream.map((current) => current.filter((each) => each.runId === runId))
    )

  const output = (terminalId: string): Stream.Stream<string> => {
    const terminal = terminals.get(terminalId)
    if (terminal === undefined) return Stream.empty
    return Stream.unwrap(
      terminal.lock.withPermits(1)(
        Effect.gen(function* () {
          const retained = terminal.chunks.join('')
          const head = retained === '' ? Stream.empty : Stream.make(retained)
          if (!terminal.running) return head
          const subscription = yield* PubSub.subscribe(terminal.published)
          return Stream.concat(
            head,
            Stream.fromSubscription(subscription).pipe(
              Stream.takeWhile(Option.isSome),
              Stream.map((chunk) => chunk.value)
            )
          )
        })
      )
    )
  }

  const read = (terminalId: string) =>
    Effect.gen(function* () {
      const terminal = terminals.get(terminalId)
      const info = yield* infoOf(terminalId)
      if (terminal === undefined || Option.isNone(info)) return Option.none()
      return Option.some({ info: info.value, output: terminal.chunks.join('') })
    })

  const whileRunning = (terminalId: string, action: string, act: (pty: NodePty.IPty) => void) =>
    Effect.suspend(() => {
      const terminal = terminals.get(terminalId)
      if (terminal === undefined || !terminal.running) return Effect.void
      return Effect.try({ try: () => act(terminal.pty), catch: describe }).pipe(
        Effect.catch((message) =>
          Effect.logDebug('A terminal call failed; its process had ended', {
            terminalId,
            action,
            message
          })
        )
      )
    })

  const stop = (terminalId: string) =>
    whileRunning(terminalId, 'stop', (pty) => pty.kill()).pipe(
      Effect.tap(() => Effect.logInfo('Terminal stopped', { terminalId }))
    )

  const remove = (terminalId: string) =>
    Effect.gen(function* () {
      yield* whileRunning(terminalId, 'stop', (pty) => pty.kill())
      const terminal = terminals.get(terminalId)
      terminals.delete(terminalId)
      if (terminal !== undefined) yield* PubSub.publish(terminal.published, Option.none())
      yield* setInfo(terminalId, Option.none())
      yield* Effect.logInfo('Terminal removed', { terminalId })
    })

  return {
    open,
    list,
    output,
    read,
    write: (terminalId, data) => whileRunning(terminalId, 'write', (pty) => pty.write(data)),
    resize: (terminalId, cols, rows) =>
      whileRunning(terminalId, 'resize', (pty) => pty.resize(cols, rows)),
    stop,
    remove
  }
})

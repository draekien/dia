import type { DiaTool, ToolScope } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, FileSystem, Option, type Scope, Stream } from 'effect'
import { makeTerminals } from './pty-terminals'
import { makeTerminalTools } from './terminal-tools'
import type { TerminalInfo, Terminals } from './terminals'

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_RUN = 'bbbbbbbb-0000-4000-8000-000000000002'
const WAIT = Duration.seconds(20)

const scopeOf = (runId: string): ToolScope => ({
  runId,
  project: 'p',
  labels: [],
  context: undefined
})

const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-terminal-tools-' })
  const terminals = yield* makeTerminals(() => Effect.succeed(Option.some(directory)))
  const tools = makeTerminalTools(terminals)
  const tool = (name: string) => tools.find((each) => each.name === name) as DiaTool
  return { terminals, tool }
})

const onlyTerminal = (terminals: Terminals, predicate: (info: TerminalInfo) => boolean) =>
  terminals.list(RUN).pipe(
    Stream.filter((list) => list.length === 1 && predicate(list[0])),
    Stream.runHead,
    Effect.map((list) => Option.getOrThrow(list)[0]),
    Effect.timeout(WAIT)
  )

const startedId = (text: string) => text.match(/Started terminal (\S+):/)?.[1] ?? ''

describe('makeTerminalTools', { timeout: 60_000 }, () => {
  it.live('starts a command a run asks for, lists it, and stops it for that run', () =>
    live(
      Effect.gen(function* () {
        const { terminals, tool } = yield* setup

        const started = yield* tool('terminal_start').run(
          { command: 'Start-Sleep -Seconds 120' },
          scopeOf(RUN)
        )

        const running = yield* onlyTerminal(terminals, (info) => info._tag === 'TerminalRunning')
        assert.isFalse(started.isError)
        assert.strictEqual(startedId(started.text), running.terminalId)

        const stopped = yield* tool('terminal_stop').run(
          { terminalId: running.terminalId },
          scopeOf(RUN)
        )

        assert.isFalse(stopped.isError)
        yield* onlyTerminal(terminals, (info) => info._tag === 'TerminalExited')
      })
    )
  )

  it.live("refuses to read or stop another run's terminal", () =>
    live(
      Effect.gen(function* () {
        const { terminals, tool } = yield* setup
        const started = yield* tool('terminal_start').run(
          { command: 'Start-Sleep -Seconds 120' },
          scopeOf(RUN)
        )
        const terminalId = startedId(started.text)

        const read = yield* tool('terminal_read').run({ terminalId }, scopeOf(OTHER_RUN))
        const stop = yield* tool('terminal_stop').run({ terminalId }, scopeOf(OTHER_RUN))

        assert.isTrue(read.isError)
        assert.isTrue(stop.isError)
        const snapshot = Option.getOrThrow(yield* terminals.read(terminalId))
        assert.strictEqual(snapshot.info._tag, 'TerminalRunning')
      })
    )
  )

  it.live('reads the exit code and the output of a finished command', () =>
    live(
      Effect.gen(function* () {
        const { terminals, tool } = yield* setup
        const started = yield* tool('terminal_start').run(
          { command: 'Write-Output ("read" + "-me"); exit 3' },
          scopeOf(RUN)
        )
        yield* onlyTerminal(terminals, (info) => info._tag === 'TerminalExited')

        const read = yield* tool('terminal_read').run(
          { terminalId: startedId(started.text) },
          scopeOf(RUN)
        )

        assert.include(read.text, 'exited with code 3')
        assert.include(read.text, 'read-me')
        assert.notInclude(read.text, '\u001b')
      })
    )
  )

  it.live('refuses to start a terminal for a caller outside dia', () =>
    live(
      Effect.gen(function* () {
        const { terminals, tool } = yield* setup

        const started = yield* tool('terminal_start').run(
          { command: 'Write-Output hi' },
          { labels: [], context: undefined }
        )

        assert.isTrue(started.isError)
        const list = yield* terminals.list(RUN).pipe(Stream.runHead, Effect.map(Option.getOrThrow))
        assert.deepStrictEqual(list, [])
      })
    )
  )
})

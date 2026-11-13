import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import {
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Result,
  type Scope,
  Stream
} from 'effect'
import { makeTerminals } from './pty-terminals'
import type { TerminalInfo, Terminals } from './terminals'

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'
const WAIT = Duration.seconds(20)

const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const runDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: 'dia-terminals-' })
})

const terminalsIn = (directory: string) =>
  makeTerminals((runId) => Effect.succeed(runId === RUN ? Option.some(directory) : Option.none()))

const firstWhere = (
  terminals: Terminals,
  predicate: (list: ReadonlyArray<TerminalInfo>) => boolean
) =>
  terminals
    .list(RUN)
    .pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.timeout(WAIT)
    )

const exited = (terminals: Terminals, terminalId: string) =>
  firstWhere(terminals, (list) =>
    list.some((info) => info.terminalId === terminalId && info._tag === 'TerminalExited')
  )

const outputUntil = (terminals: Terminals, terminalId: string, text: string) =>
  terminals.output(terminalId).pipe(
    Stream.scan(
      () => '',
      (all, chunk) => all + chunk
    ),
    Stream.filter((all) => all.includes(text)),
    Stream.runHead,
    Effect.timeout(WAIT)
  )

describe('makeTerminals', { timeout: 60_000 }, () => {
  it.live("runs a command in the run's working directory and lists it until it exits", () =>
    live(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* runDirectory
        yield* fs.writeFileString(path.join(directory, 'only-in-this-run.txt'), '')
        const terminals = yield* terminalsIn(directory)

        const opened = yield* terminals.open(RUN, 'Get-ChildItem -Name')

        assert.strictEqual(opened._tag, 'TerminalRunning')
        const list = yield* exited(terminals, opened.terminalId)
        const snapshot = yield* terminals.read(opened.terminalId)
        assert.deepStrictEqual(list, [
          {
            _tag: 'TerminalExited',
            terminalId: opened.terminalId,
            runId: RUN,
            title: 'Get-ChildItem -Name',
            exitCode: 0
          }
        ])
        assert.include(Option.getOrThrow(snapshot).output, 'only-in-this-run.txt')
      })
    )
  )

  it.live(
    'replays retained output to a follower that attaches after the exit, then completes',
    () =>
      live(
        Effect.gen(function* () {
          const terminals = yield* terminalsIn(yield* runDirectory)
          const opened = yield* terminals.open(RUN, 'Write-Output ("replay" + "-me")')
          yield* exited(terminals, opened.terminalId)

          const chunks = yield* terminals
            .output(opened.terminalId)
            .pipe(Stream.runCollect, Effect.timeout(WAIT))

          assert.include(chunks.join(''), 'replay-me')
        })
      )
  )

  it.live('passes a command with double quotes and & to PowerShell as written', () =>
    live(
      Effect.gen(function* () {
        const terminals = yield* terminalsIn(yield* runDirectory)
        const opened = yield* terminals.open(RUN, 'Write-Output "a&b"')

        yield* exited(terminals, opened.terminalId)

        const snapshot = Option.getOrThrow(yield* terminals.read(opened.terminalId))
        assert.include(snapshot.output, 'a&b')
      })
    )
  )

  it.live('sends typed input to an interactive shell', () =>
    live(
      Effect.gen(function* () {
        const terminals = yield* terminalsIn(yield* runDirectory)
        const opened = yield* terminals.open(RUN)

        yield* terminals.write(opened.terminalId, 'Write-Output ("typed" + "-input")\r')

        const seen = yield* outputUntil(terminals, opened.terminalId, 'typed-input')
        assert.isTrue(Option.isSome(seen))
      })
    )
  )

  it.live('stops a running process and keeps it listed as exited', () =>
    live(
      Effect.gen(function* () {
        const terminals = yield* terminalsIn(yield* runDirectory)
        const opened = yield* terminals.open(RUN, 'Start-Sleep -Seconds 120')

        yield* terminals.stop(opened.terminalId)

        const list = yield* exited(terminals, opened.terminalId)
        assert.strictEqual(list.length, 1)
      })
    )
  )

  it.live('drops a removed terminal from its run and ends its output', () =>
    live(
      Effect.gen(function* () {
        const terminals = yield* terminalsIn(yield* runDirectory)
        const opened = yield* terminals.open(RUN, 'Start-Sleep -Seconds 120')
        const output = yield* Effect.forkChild(Stream.runDrain(terminals.output(opened.terminalId)))

        yield* terminals.remove(opened.terminalId)

        assert.deepStrictEqual(yield* firstWhere(terminals, (list) => list.length === 0), [])
        assert.isTrue(
          Result.isSuccess(yield* Effect.result(Effect.timeout(Fiber.await(output), WAIT)))
        )
        assert.isTrue(Option.isNone(yield* terminals.read(opened.terminalId)))
      })
    )
  )

  it.live('fails to open a terminal for an unknown run', () =>
    live(
      Effect.gen(function* () {
        const terminals = yield* terminalsIn(yield* runDirectory)

        const opened = yield* Effect.result(terminals.open('unknown-run'))

        assert.isTrue(Result.isFailure(opened))
        assert.strictEqual(Result.isFailure(opened) && opened.failure._tag, 'TerminalOpenError')
      })
    )
  )
})

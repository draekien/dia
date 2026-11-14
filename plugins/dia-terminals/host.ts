import type { HostPluginContext, PluginSetup, Runs } from '@dia/plugin'
import { RunsKey } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Effect, Option, Ref } from 'effect'
import {
  FollowTerminalOutput,
  FollowTerminals,
  OpenTerminal,
  RemoveTerminal,
  ResizeTerminal,
  StopTerminal,
  WriteTerminal
} from './calls'
import { makeTerminals } from './pty-terminals'
import { TerminalsKey } from './terminals'

const cwdOf = (provided: Ref.Ref<Option.Option<Runs>>) => (runId: string) =>
  Effect.gen(function* () {
    const runs = yield* Ref.get(provided)
    if (Option.isNone(runs)) return Option.none<string>()
    const list = yield* runs.value.list
    return Option.fromUndefinedOr(list.find((run) => run.runId === runId)?.cwd)
  })

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(Option.none<Runs>())
    yield* ctx.whenProvided([RunsKey], ({ runs: current }) =>
      Effect.acquireRelease(Ref.set(runs, Option.some(current)), () => Ref.set(runs, Option.none()))
    )
    const terminals = yield* makeTerminals(cwdOf(runs))
    yield* ctx.provide(TerminalsKey, terminals)
    yield* ctx.serve(FollowTerminals, ({ runId }) => terminals.list(runId))
    yield* ctx.serve(OpenTerminal, ({ runId }) => terminals.open(runId))
    yield* ctx.serve(FollowTerminalOutput, ({ terminalId }) => terminals.output(terminalId))
    yield* ctx.serve(WriteTerminal, ({ terminalId, data }) => terminals.write(terminalId, data))
    yield* ctx.serve(ResizeTerminal, ({ terminalId, cols, rows }) =>
      terminals.resize(terminalId, cols, rows)
    )
    yield* ctx.serve(StopTerminal, ({ terminalId }) => terminals.stop(terminalId))
    yield* ctx.serve(RemoveTerminal, ({ terminalId }) => terminals.remove(terminalId))
    yield* Effect.logInfo('Terminals provided', { plugin: ctx.name })
  }).pipe(Effect.provide(NodeCrypto.layer))

export default setup

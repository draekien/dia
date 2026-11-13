import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'
import { TerminalInfo, TerminalOpenError } from './terminals'

const TerminalId = { terminalId: Schema.String }

/** Run `runId`'s terminals in opening order, now and after each change; empty while none run. */
export const FollowTerminals = Rpc.make('FollowTerminals', {
  payload: { runId: Schema.String },
  success: Schema.Array(TerminalInfo),
  stream: true
})

/** Opens an interactive shell in run `runId`'s working directory and returns its terminal. */
export const OpenTerminal = Rpc.make('OpenTerminal', {
  payload: { runId: Schema.String },
  success: TerminalInfo,
  error: TerminalOpenError
})

/** Terminal `terminalId`'s retained output, then each new chunk, until it exits or is removed. */
export const FollowTerminalOutput = Rpc.make('FollowTerminalOutput', {
  payload: TerminalId,
  success: Schema.String,
  stream: true
})

/** Sends `data` to terminal `terminalId` as typed input. */
export const WriteTerminal = Rpc.make('WriteTerminal', {
  payload: { ...TerminalId, data: Schema.String }
})

const CellCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Sets terminal `terminalId`'s size to `cols` by `rows` character cells. */
export const ResizeTerminal = Rpc.make('ResizeTerminal', {
  payload: { ...TerminalId, cols: CellCount, rows: CellCount }
})

/** Kills terminal `terminalId`'s process; the terminal stays listed as exited. */
export const StopTerminal = Rpc.make('StopTerminal', { payload: TerminalId })

/** Stops terminal `terminalId` if it runs and drops it from its run's list. */
export const RemoveTerminal = Rpc.make('RemoveTerminal', { payload: TerminalId })

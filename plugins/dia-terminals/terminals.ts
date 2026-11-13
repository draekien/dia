import { ServiceKey } from '@dia/plugin'
import { type Effect, type Option, Predicate, Schema, type Stream } from 'effect'

/** A terminal whose process runs, in run `runId`. `title` is its command, or the shell's name. */
export const TerminalRunning = Schema.TaggedStruct('TerminalRunning', {
  terminalId: Schema.String,
  runId: Schema.String,
  title: Schema.String
})
/** A running terminal; see {@link TerminalRunning}. */
export type TerminalRunning = typeof TerminalRunning.Type

/** A terminal whose process ended with `exitCode`; its output stays readable until it is removed. */
export const TerminalExited = Schema.TaggedStruct('TerminalExited', {
  terminalId: Schema.String,
  runId: Schema.String,
  title: Schema.String,
  exitCode: Schema.Int
})
/** An exited terminal; see {@link TerminalExited}. */
export type TerminalExited = typeof TerminalExited.Type

/** One terminal of a run, running or exited. */
export const TerminalInfo = Schema.Union([TerminalRunning, TerminalExited])
/** One terminal of a run; see {@link TerminalInfo}. */
export type TerminalInfo = typeof TerminalInfo.Type

/**
 * A terminal could not open for run `runId`: runs are not provided, the run is unknown, or the
 * process failed to start. `message` says which.
 */
export class TerminalOpenError extends Schema.TaggedError<TerminalOpenError>()(
  'TerminalOpenError',
  { runId: Schema.String, message: Schema.String }
) {}

/** A terminal's state and its retained output at one moment, as {@link Terminals.read} returns it. */
export interface TerminalSnapshot {
  readonly info: TerminalInfo
  readonly output: string
}

/**
 * Pseudo-terminals per run, as `dia-terminals` provides them under {@link TerminalsKey}
 * (`docs/designs/dia-terminals.md`). Read it with `ctx.whenProvided`. Terminals end when
 * `dia-terminals` reloads or dia quits. Members that take a terminal id do nothing for an unknown
 * id, so no caller handles a not-found error.
 *
 * - `open` starts a PTY in run `runId`'s working directory running `command` through the shell,
 *   or an interactive shell when `command` is undefined.
 * - `list` emits run `runId`'s terminals in opening order, now and after each change.
 * - `output` emits the terminal's retained output (about the last 1 MiB) as one chunk, then each
 *   new chunk, and completes when the terminal exits or is removed.
 * - `read` returns the state and retained output now, for a caller that reads once.
 * - `write` sends `data` as typed input and `resize` sets the size in character cells; both do
 *   nothing unless the terminal runs.
 * - `stop` kills the process and keeps the terminal listed as exited; `remove` stops it if it
 *   runs and drops it from its run's list.
 */
export interface Terminals {
  readonly open: (runId: string, command?: string) => Effect.Effect<TerminalInfo, TerminalOpenError>
  readonly list: (runId: string) => Stream.Stream<ReadonlyArray<TerminalInfo>>
  readonly output: (terminalId: string) => Stream.Stream<string>
  readonly read: (terminalId: string) => Effect.Effect<Option.Option<TerminalSnapshot>>
  readonly write: (terminalId: string, data: string) => Effect.Effect<void>
  readonly resize: (terminalId: string, cols: number, rows: number) => Effect.Effect<void>
  readonly stop: (terminalId: string) => Effect.Effect<void>
  readonly remove: (terminalId: string) => Effect.Effect<void>
}

const MEMBERS = ['open', 'list', 'output', 'read', 'write', 'resize', 'stop', 'remove'] as const

const isTerminals = (value: unknown): value is Terminals =>
  MEMBERS.every(
    (member) => Predicate.hasProperty(value, member) && Predicate.isFunction(value[member])
  )

/** The key `dia-terminals` provides its {@link Terminals} under: `terminals`. */
export const TerminalsKey = ServiceKey.make('terminals', isTerminals)

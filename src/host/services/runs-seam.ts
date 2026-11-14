import type { Attachment } from '@shared/domain/attachment'
import {
  PermissionResponse,
  QuestionResponse,
  type UserInputRequest
} from '@shared/domain/attention'
import type { SendMode } from '@shared/domain/message-queue'
import {
  type PaneConfig,
  PermissionMode,
  SessionId,
  ThinkingLevel,
  type WorktreeInfo
} from '@shared/domain/pane'
import { ServiceKey } from '@shared/plugin/api'
import { Data, type Effect, type Option, Predicate, Schema, type Stream } from 'effect'
import type { WorktreeCreateError, WorktreeReattachError } from './worktrees-seam'

/**
 * How a run's worktree is obtained. `Create` provisions a new worktree recorded under `label` on
 * Settings › Worktrees; `Reattach` re-adds the run's existing worktree from its {@link WorktreeInfo},
 * checking out its branch. Absent from a {@link RunSpec} means the run works in `sourceCwd`.
 */
export type WorktreeRequest =
  | { readonly _tag: 'Create'; readonly label: string }
  | { readonly _tag: 'Reattach'; readonly info: WorktreeInfo }

/**
 * What a run opens with: its id, the directory and model the user chose, how its worktree is
 * obtained, and the conversation it continues (`resume`), or none for a new one. `labels` and
 * `context` become the run's dia tool scope (see `ToolScope`); `context` must be
 * JSON-serialisable, because it is stored with the run.
 */
export interface RunSpec {
  readonly runId: string
  readonly sourceCwd: string
  readonly model: string
  readonly thinkingLevel: ThinkingLevel
  readonly permissionMode: PermissionMode
  readonly worktree: WorktreeRequest | undefined
  readonly resume: Option.Option<SessionId>
  readonly labels?: ReadonlyArray<string>
  readonly context?: unknown
}

/**
 * What {@link Runs.start} starts: a run with no tab working in `cwd`, sent `text` at once.
 * `labels` and `context` become the run's dia tool scope; dia tools registered for that scope
 * receive `context` with every call. `context` must be JSON-serialisable.
 */
export interface StartRunOptions {
  readonly cwd: string
  readonly model: string
  readonly thinkingLevel: ThinkingLevel
  readonly permissionMode: PermissionMode
  readonly text: string
  readonly labels?: ReadonlyArray<string>
  readonly context?: unknown
}

/**
 * A conversation an agent harness holds, as `Runs.discoverSessions` reports it. `title` is the
 * harness's name for it and may be empty; `startedAt` is when it began, in epoch milliseconds;
 * `model` is the model value a session that resumes it is opened with.
 */
export interface DiscoveredSession {
  readonly sessionId: SessionId
  readonly title: string
  readonly startedAt: number
  readonly model: string
}

/** Answers a permission request with `response`. */
export const PermissionAnswer = Schema.TaggedStruct('PermissionAnswer', {
  response: PermissionResponse
})
/** Answers a clarifying question with `response`. */
export const QuestionAnswer = Schema.TaggedStruct('QuestionAnswer', { response: QuestionResponse })
/** Approves (`approved: true`) or rejects a plan review. */
export const PlanReviewAnswer = Schema.TaggedStruct('PlanReviewAnswer', {
  approved: Schema.Boolean
})
/** An answer to one open request of a run, matched to the request's kind. */
export const RunAnswer = Schema.Union([PermissionAnswer, QuestionAnswer, PlanReviewAnswer])
export type RunAnswer = typeof RunAnswer.Type

/** One open request of run `runId`, as the session raised it. Answer it with `Runs.answer`. */
export interface RunRequest {
  readonly runId: string
  readonly request: UserInputRequest
}

/** A run's status as `Runs.list` reports it; `waiting` means a request is open. */
export const RunStatus = Schema.Literals(['idle', 'running', 'waiting', 'archived'])
export type RunStatus = typeof RunStatus.Type

/**
 * One run as `Runs.list` reports it. `cwd` is where its session works (its worktree when it has
 * one); `model`, `thinkingLevel` and `permissionMode` are the ones it opens with. `live` is true
 * while its session runs.
 */
export interface RunInfo {
  readonly runId: string
  readonly cwd: string
  readonly model: string
  readonly thinkingLevel: ThinkingLevel
  readonly permissionMode: PermissionMode
  readonly sessionId: Option.Option<SessionId>
  readonly status: RunStatus
  readonly live: boolean
}

/** Run `runId`'s conversation is now `sessionId`, or none when the one it resumed does not exist. */
export const RunSessionChanged = Schema.TaggedStruct('RunSessionChanged', {
  runId: Schema.String,
  sessionId: Schema.NullOr(SessionId)
})
/** Run `runId` changed its own permission mode to `mode` (a plan was approved). */
export const RunPermissionModeChanged = Schema.TaggedStruct('RunPermissionModeChanged', {
  runId: Schema.String,
  mode: PermissionMode
})
/**
 * Where `Runs.openInTab` puts a run's tab: in the project at `projectDirectory`, and, when `select`
 * is true, as the visible tab. A run working in a worktree of a project passes that project's
 * directory.
 */
export const TabPlacement = Schema.Struct({
  projectDirectory: Schema.String,
  select: Schema.Boolean
})
export type TabPlacement = typeof TabPlacement.Type

/**
 * Run `runId`, which has no tab, asks to be shown in a tab working in `directory`, in the project
 * at `projectDirectory`; the tab becomes the visible tab when `select` is true.
 */
export const RunTabRequested = Schema.TaggedStruct('RunTabRequested', {
  runId: Schema.String,
  directory: Schema.String,
  ...TabPlacement.fields,
  model: Schema.String,
  thinkingLevel: ThinkingLevel,
  permissionMode: PermissionMode,
  sessionId: Schema.NullOr(SessionId)
})
/** A change the owner of tabs follows through `Runs.changes`. */
export const RunChange = Schema.Union([
  RunSessionChanged,
  RunPermissionModeChanged,
  RunTabRequested
])
export type RunChange = typeof RunChange.Type

/** `Runs.openInTab` named a run `dia-runs` holds no row for. */
export class RunNotFoundError extends Data.TaggedError('RunNotFoundError')<{
  readonly runId: string
}> {}

/** No loaded plugin provides {@link RunsKey}, so no run can be opened. */
export class RunsNotLoadedError extends Data.TaggedError('RunsNotLoadedError')<{
  readonly runId: string
}> {}

/**
 * Every agent session as a run, as `dia-runs` provides it under {@link RunsKey} (ADR-0074). A run
 * exists with or without a tab; a tab's run id is its pane id. Every method other than `open`,
 * `start` and `openInTab` logs and does nothing for a run that is not live or not known. Events a
 * run produces reach its event log in `dia-run-events` in the order its session emits them: a
 * turn's last message is committed before the `PaneAttentionChanged` that ends the turn.
 */
export interface Runs {
  /**
   * Opens run `spec.runId` unless it is live: provisions its worktree, starts its session and
   * stores its row. Returns the config it runs with. Opening a run whose stored status says a turn
   * was in progress resumes that turn.
   */
  readonly open: (
    spec: RunSpec
  ) => Effect.Effect<PaneConfig, WorktreeCreateError | WorktreeReattachError>
  /** Starts a run with no tab and sends it `options.text`; returns its id. */
  readonly start: (options: StartRunOptions) => Effect.Effect<string>
  /**
   * Sends a user message to run `runId`, opening the run from its row when it is not live. During
   * a turn `queue` holds it until the turn ends and `steer` interrupts the turn so it runs next.
   */
  readonly send: (
    runId: string,
    text: string,
    mode: SendMode,
    attachments?: ReadonlyArray<Attachment>
  ) => Effect.Effect<void>
  /** Replaces the text (and attachments, when given) of queued message `messageId`. */
  readonly editQueued: (
    runId: string,
    messageId: string,
    text: string,
    attachments?: ReadonlyArray<Attachment>
  ) => Effect.Effect<void>
  /** Removes queued message `messageId`. */
  readonly removeQueued: (runId: string, messageId: string) => Effect.Effect<void>
  /** Sends queued message `messageId` now, interrupting a running turn. */
  readonly sendQueuedNow: (runId: string, messageId: string) => Effect.Effect<void>
  /** Answers open request `requestId` of run `runId`; an answer of the wrong kind is ignored. */
  readonly answer: (runId: string, requestId: string, answer: RunAnswer) => Effect.Effect<void>
  /** Every open request of every live run, now and after each change. */
  readonly requests: Stream.Stream<ReadonlyArray<RunRequest>>
  /**
   * The ids of the live runs that are busy, now and after each change of the set: a turn is in
   * progress and no request is open, or one or more background tasks run. A run waiting for the
   * user is not busy. A run `start` returned is busy before its session reports the turn.
   */
  readonly busy: Stream.Stream<ReadonlyArray<string>>
  /** Interrupts run `runId`'s turn. */
  readonly interrupt: (runId: string) => Effect.Effect<void>
  /** Resumes run `runId` when a usage limit parked it. */
  readonly resumeParked: (runId: string) => Effect.Effect<void>
  /**
   * Rewinds run `runId`'s files and conversation to the user message `messageUuid`, opening the
   * run from its row when it is not live.
   */
  readonly rewind: (
    runId: string,
    messageUuid: string,
    resumeAnchorUuid: string | undefined
  ) => Effect.Effect<void>
  /** Applies `level` to run `runId` from its next turn and stores it. */
  readonly setThinkingLevel: (runId: string, level: ThinkingLevel) => Effect.Effect<void>
  /** Applies `mode` to run `runId` at once and stores it. */
  readonly setPermissionMode: (runId: string, mode: PermissionMode) => Effect.Effect<void>
  /** Makes run `runId`'s next turn use `model` and stores it. */
  readonly setModel: (runId: string, model: string) => Effect.Effect<void>
  /** Completes when run `runId` has no turn in progress (at once for a run that is not live). */
  readonly awaitIdle: (runId: string) => Effect.Effect<void>
  /** Whether run `runId`'s session runs. */
  readonly isLive: (runId: string) => Effect.Effect<boolean>
  /** Ends run `runId`'s session and releases its worktree; its row and status stay. */
  readonly close: (runId: string) => Effect.Effect<void>
  /** Closes run `runId` and marks it archived, or deletes its row. */
  readonly retire: (runId: string, as: 'archived' | 'deleted') => Effect.Effect<void>
  /** Every run with a row. */
  readonly list: Effect.Effect<ReadonlyArray<RunInfo>>
  /**
   * Asks the owner of tabs to show run `runId` in a tab (a {@link RunTabRequested} change). Without
   * `placement` the tab joins the project at the run's directory and becomes the visible tab.
   */
  readonly openInTab: (
    runId: string,
    placement?: TabPlacement
  ) => Effect.Effect<void, RunNotFoundError>
  /** Every {@link RunChange} from now on. */
  readonly changes: Stream.Stream<RunChange>
  /**
   * The conversations the agent harness holds whose working directory is `directory`. Never
   * fails: empty when there are none, they cannot be read, or the adapter cannot list them.
   */
  readonly discoverSessions: (directory: string) => Effect.Effect<ReadonlyArray<DiscoveredSession>>
}

const RUNS_FUNCTIONS = [
  'open',
  'start',
  'send',
  'editQueued',
  'removeQueued',
  'sendQueuedNow',
  'answer',
  'interrupt',
  'resumeParked',
  'rewind',
  'setThinkingLevel',
  'setPermissionMode',
  'setModel',
  'awaitIdle',
  'isLive',
  'close',
  'retire',
  'openInTab',
  'discoverSessions'
] as const

const isRuns = (value: unknown): value is Runs =>
  RUNS_FUNCTIONS.every(
    (member) => Predicate.hasProperty(value, member) && Predicate.isFunction(value[member])
  ) && Predicate.hasProperty(value, 'busy')

/**
 * The key `dia-runs` provides {@link Runs} under, named `runs`. A value counts as provided when
 * every method of {@link Runs} is a function and it has `busy`. Read it with `ctx.whenProvided`.
 */
export const RunsKey = ServiceKey.make('runs', isRuns)

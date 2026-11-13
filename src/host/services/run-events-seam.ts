import { AgentEvent } from '@shared/domain/agent-event'
import { SessionId } from '@shared/domain/pane'
import type { PaneChatSnapshot } from '@shared/domain/pane-chat'
import { PaneSignal } from '@shared/ipc/contract'
import { ServiceKey } from '@shared/plugin/api'
import { Data, Effect, type Option, Predicate, Schema, type Scope, Stream } from 'effect'
import type { NonEmptyReadonlyArray } from 'effect/Array'
import type { OutboundMessage } from '../session/protocol'

/**
 * Any event a run's log stores: a conversation {@link AgentEvent}, which also updates the run's
 * items, or a {@link PaneSignal} about the run's tab, which is stored and replayed only.
 */
export const StoredEvent = Schema.Union([AgentEvent, PaneSignal])
/** A stored event; see {@link StoredEvent}. */
export type StoredEvent = typeof StoredEvent.Type

/** An event to append, with the SDK message uuid it came from when it came from one. */
export interface AppendEntry {
  readonly event: StoredEvent
  readonly sourceUuid?: string
}

/** A stored event of run `runId` with the `sequence` its row was committed under. */
export const CommittedEvent = Schema.Struct({
  runId: Schema.String,
  sequence: Schema.Int,
  event: StoredEvent
})
/** A committed event; see {@link CommittedEvent}. */
export type CommittedEvent = typeof CommittedEvent.Type

/**
 * The events of a run after a cursor, in sequence order, and `through`: the run's highest sequence
 * when they were read. Every event of the run up to `through` is in `events` or at or before the
 * cursor.
 */
export const Replay = Schema.TaggedStruct('Replay', {
  events: Schema.Array(CommittedEvent),
  through: Schema.Int
})
/** A replay; see {@link Replay}. */
export type Replay = typeof Replay.Type

/**
 * The events after a cursor cannot be replayed, so the reader must start from the run's history:
 * the cursor is past the run's last event (`ahead`), there are more events or bytes than the
 * limits allow (`tooLarge`), one of them does not decode (`undecodable`), or the log could not be
 * read (`readFailed`).
 */
export const ReloadRequired = Schema.TaggedStruct('ReloadRequired', {
  reason: Schema.Literals(['ahead', 'tooLarge', 'undecodable', 'readFailed'])
})
/** A reload requirement; see {@link ReloadRequired}. */
export type ReloadRequired = typeof ReloadRequired.Type

/** How many events (`maxEvents`) and payload bytes (`maxBytes`) one replay may hold. */
export interface ReplayLimits {
  readonly maxEvents: number
  readonly maxBytes: number
}

/** A write to the run event log failed; the failing method states what stays stored. */
export class RunEventWriteError extends Data.TaggedError('RunEventWriteError')<{
  readonly cause: unknown
}> {}

/** A read of the run event log failed. */
export class RunEventReadError extends Data.TaggedError('RunEventReadError')<{
  readonly cause: unknown
}> {}

/**
 * Where catch-up resumes reading SDK session `sessionId`'s transcript: after entry `lastUuid`,
 * when the file's size (`fileSize`, bytes) or modification time (`mtimeMs`, epoch ms) differs.
 */
export const TranscriptCursor = Schema.Struct({
  sessionId: SessionId,
  lastUuid: Schema.String,
  fileSize: Schema.Int,
  mtimeMs: Schema.Int
})
/** A transcript cursor; see {@link TranscriptCursor}. */
export type TranscriptCursor = typeof TranscriptCursor.Type

/** What {@link RunEvents.record} needs to know about the session it records. */
export interface RecordingOptions {
  /** The run the session belongs to; a tab's run id is its pane id until `dia-runs` exists. */
  readonly runId: string
  /** The session's working directory, where its transcript is found. */
  readonly cwd: string
  /** The SDK session the run resumes, or none for a new conversation. */
  readonly resume: Option.Option<SessionId>
}

/**
 * The run event log, item projection and chat snapshots, as the `dia-run-events` plugin provides
 * them under {@link RunEventsKey}. A run id is a string; a tab's run id is its pane id.
 */
export interface RunEvents {
  /**
   * Appends `events` to run `runId`'s log in order, in one transaction, and updates the run's
   * items. `sourceUuid` is the SDK message uuid an event came from; an event whose `sourceUuid` and
   * item are already stored is skipped. Returns one entry per input event: `Some(sequence)` when
   * appended, `None` when skipped. Sequences increase but are not contiguous. Every appended event
   * is offered to `committed` once the transaction commits. Appending `AgentArchived` also deletes,
   * for good, the run's streaming `MessageUpdated` and `ReasoningUpdated` events that a later event
   * of the same item replaced. Fails with {@link RunEventWriteError}, and then nothing from the
   * batch is stored, deleted or offered.
   */
  readonly append: (
    runId: string,
    events: ReadonlyArray<AppendEntry>
  ) => Effect.Effect<ReadonlyArray<Option.Option<number>>, RunEventWriteError>
  /**
   * Every event committed from now on, by any run, in sequence order. Each subscriber receives the
   * events committed after it subscribed; none is dropped.
   */
  readonly committed: Stream.Stream<CommittedEvent>
  /**
   * Subscribes at once, in the calling scope, and returns every event committed after the call,
   * by any run, in sequence order. Use it, not `committed`, to read a run's state and then follow
   * the events after it: `committed` subscribes only when it is first pulled, so events committed
   * in between are missed.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<CommittedEvent>, never, Scope.Scope>
  /**
   * The events of run `runId` after sequence `afterSequence`: a {@link Replay}, or
   * {@link ReloadRequired} when they cannot be replayed within `limits` (bytes count each event's
   * stored JSON in UTF-8). Never fails; a failed read is returned as `readFailed`.
   */
  readonly readAfter: (
    runId: string,
    afterSequence: number,
    limits: ReplayLimits
  ) => Effect.Effect<Replay | ReloadRequired>
  /**
   * The events of run `runId` whose tag is one of `tags`, in sequence order. An event that does not
   * decode is left out and logged. Fails with {@link RunEventReadError} when the log cannot be read.
   */
  readonly readTagged: (
    runId: string,
    tags: NonEmptyReadonlyArray<StoredEvent['_tag']>
  ) => Effect.Effect<ReadonlyArray<CommittedEvent>, RunEventReadError>
  /** The highest sequence of any run, or 0 when none has an event. */
  readonly highestSequence: Effect.Effect<number, RunEventReadError>
  /** The highest sequence when this provider started, before it accepted any append. */
  readonly startSequence: number
  /**
   * Starts recording one session of run `options.runId`. Call it before the session starts.
   * Returns the function to call with every `OutboundMessage` the session emits, in order.
   * Recording lives in the surrounding scope; closing it writes the final state of unfinished
   * items. The function never fails: a failed write is logged. When `resume` is some, first
   * imports the entries of that session's transcript the run has not stored.
   */
  readonly record: (
    options: RecordingOptions
  ) => Effect.Effect<(message: OutboundMessage) => Effect.Effect<void>, never, Scope.Scope>
  /**
   * The run's chat state and the sequence of the last event in it. A workspace tab with no state
   * yet is seeded first; an id never seeded gets the empty state at sequence 0.
   */
  readonly snapshot: (runId: string) => Effect.Effect<PaneChatSnapshot>
  /**
   * Builds the run's chat state from its stored log unless it has one, first importing the turns
   * its transcript holds that are not stored (turns added outside dia). Call it before a session for
   * the run starts.
   */
  readonly seed: (runId: string) => Effect.Effect<void>
  /**
   * Drops the in-memory chat state of a run that is not a workspace tab, such as a detached
   * session's. Deletes no event. Does nothing for a workspace tab or an id with no state.
   */
  readonly release: (runId: string) => Effect.Effect<void>
}

const functionMembers = [
  'append',
  'readAfter',
  'readTagged',
  'record',
  'snapshot',
  'seed',
  'release'
] as const

const isRunEvents = (value: unknown): value is RunEvents =>
  functionMembers.every(
    (member) => Predicate.hasProperty(value, member) && Predicate.isFunction(value[member])
  ) &&
  Predicate.hasProperty(value, 'committed') &&
  Stream.isStream(value.committed) &&
  Predicate.hasProperty(value, 'subscribe') &&
  Effect.isEffect(value.subscribe) &&
  Predicate.hasProperty(value, 'highestSequence') &&
  Effect.isEffect(value.highestSequence) &&
  Predicate.hasProperty(value, 'startSequence') &&
  Predicate.isNumber(value.startSequence)

/**
 * The key `dia-run-events` provides {@link RunEvents} under, named `runEvents`. A value whose
 * members do not have the shapes {@link RunEvents} names reads as not provided. Host code reads it
 * through `RunEventLog`.
 */
export const RunEventsKey = ServiceKey.make('runEvents', isRunEvents)

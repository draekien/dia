import { PaneChat, StoredEvent } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/** A run's chat state and the sequence of the last event in it; the first update of a follow. */
export const RunChatSnapshot = Schema.TaggedStruct('RunChatSnapshot', {
  snapshot: PaneChat.PaneChatSnapshot
})
export type RunChatSnapshot = typeof RunChatSnapshot.Type

/** One event of the followed run, committed after the snapshot, with its `sequence`. */
export const RunEventCommitted = Schema.TaggedStruct('RunEventCommitted', {
  sequence: Schema.Int,
  event: StoredEvent
})
export type RunEventCommitted = typeof RunEventCommitted.Type

/** What {@link FollowRunChat} streams: a {@link RunChatSnapshot}, then {@link RunEventCommitted}s. */
export const RunChatUpdate = Schema.Union([RunChatSnapshot, RunEventCommitted])
export type RunChatUpdate = typeof RunChatUpdate.Type

/**
 * Follows run `runId`'s chat from a renderer entry with
 * `followHost('dia-run-events', FollowRunChat, { runId })`: its snapshot first, then each event of
 * `runId` committed after the snapshot, in sequence order. Fold the events onto the snapshot's
 * state with `reducePaneChat`. A resubscription starts again from a snapshot.
 */
export const FollowRunChat = Rpc.make('FollowRunChat', {
  payload: { runId: Schema.String },
  success: RunChatUpdate,
  stream: true
})

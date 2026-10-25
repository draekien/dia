import { Schema } from 'effect'
import { SessionId } from './pane'
import { AgentName, type Tab } from './project'
import { Uuid } from './uuid'

/** An agent of the project being removed; removing it stops its session. */
export const AgentItem = Schema.TaggedStruct('AgentItem', { paneId: Uuid, name: AgentName })
export type AgentItem = typeof AgentItem.Type

/** A git worktree an agent of the project ran in; removing it deletes the worktree directory. */
export const WorktreeItem = Schema.TaggedStruct('WorktreeItem', { path: Schema.String })
export type WorktreeItem = typeof WorktreeItem.Type

/** A conversation transcript of an agent of the project; removing it deletes the transcript. */
export const TranscriptItem = Schema.TaggedStruct('TranscriptItem', { sessionId: SessionId })
export type TranscriptItem = typeof TranscriptItem.Type

/** One thing removing a project removes. The project directory itself is never one. */
export const RemovalItem = Schema.Union([AgentItem, WorktreeItem, TranscriptItem])
export type RemovalItem = typeof RemovalItem.Type

/**
 * Everything removing the project of `tab` deletes for that tab, in the order the Host removes
 * it: the agent, then its worktree and transcript when it has them.
 */
export const removalItemsOf = (tab: Tab): ReadonlyArray<RemovalItem> => [
  AgentItem.make({ paneId: tab.config.paneId, name: tab.name }),
  ...(tab.config.worktree === undefined
    ? []
    : [WorktreeItem.make({ path: tab.config.worktree.path })]),
  ...(tab.sessionId === undefined ? [] : [TranscriptItem.make({ sessionId: tab.sessionId })])
]

/** Removal of `item` has started. */
export const Removing = Schema.TaggedStruct('Removing', { item: RemovalItem })
export type Removing = typeof Removing.Type

/** `item` is removed. */
export const Removed = Schema.TaggedStruct('Removed', { item: RemovalItem })
export type Removed = typeof Removed.Type

/** `item` could not be removed; `reason` says why. Removing the project again retries it. */
export const RemoveFailed = Schema.TaggedStruct('RemoveFailed', {
  item: RemovalItem,
  reason: Schema.String
})
export type RemoveFailed = typeof RemoveFailed.Type

/** The project is gone from the workspace. Always the last progress item when it appears. */
export const ProjectRemoved = Schema.TaggedStruct('ProjectRemoved', {})
export type ProjectRemoved = typeof ProjectRemoved.Type

/**
 * One step of removing a project, streamed in order. The stream ends after `ProjectRemoved`, or
 * without it when an item failed; then the project stays, and removing it again retries the
 * failed items, or `force` drops it and leaves them on disk.
 */
export const RemovalProgress = Schema.Union([Removing, Removed, RemoveFailed, ProjectRemoved])
export type RemovalProgress = typeof RemovalProgress.Type

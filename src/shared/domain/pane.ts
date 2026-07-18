import { Schema } from 'effect'
import { AttentionState } from './attention'

/**
 * A single turn in a pane's conversation history, as exchanged with Claude.
 * Use to append to or read `PaneRecord.history`.
 */
export const ConversationMessage = Schema.Struct({
  role: Schema.Literal('user', 'assistant'),
  content: Schema.String
})
export type ConversationMessage = typeof ConversationMessage.Type

/**
 * Identifies the git worktree a pane is running in, when the pane was
 * created against a worktree rather than the source repo directly.
 * Attach to `PaneConfig.worktree` when a pane needs isolated working-tree state.
 */
export const WorktreeInfo = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  sourceRepo: Schema.String
})
export type WorktreeInfo = typeof WorktreeInfo.Type

/**
 * How much extended thinking the pane's agent should do. `off` disables it,
 * `adaptive` lets Claude decide when and how much to think, and `low`/`medium`/
 * `high` guide adaptive thinking's depth. Consumed by the pane process to
 * derive the Agent SDK `thinking`/`effort` query options.
 */
export const ThinkingLevel = Schema.Literal('off', 'adaptive', 'low', 'medium', 'high')
export type ThinkingLevel = typeof ThinkingLevel.Type

/**
 * The thinking level a pane starts with when the user does not choose one:
 * `adaptive`, matching the Agent SDK's own default for supported models.
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'adaptive'

/**
 * The configuration needed to start or restore a pane: its identity, working
 * directory, model, thinking level, and optional worktree binding. Pass this
 * when creating a new pane or persisting/restoring one across sessions.
 * `thinkingLevel` defaults to {@link DEFAULT_THINKING_LEVEL} when absent, so
 * records persisted before it existed still decode.
 */
export const PaneConfig = Schema.Struct({
  paneId: Schema.UUID,
  cwd: Schema.String,
  model: Schema.String,
  thinkingLevel: Schema.optionalWith(ThinkingLevel, { default: () => DEFAULT_THINKING_LEVEL }),
  worktree: Schema.optional(WorktreeInfo)
})
export type PaneConfig = typeof PaneConfig.Type

/**
 * The full persisted state of a pane: its config, conversation history, and
 * current attention state. Use as the unit of storage/retrieval for a pane.
 */
export const PaneRecord = Schema.Struct({
  config: PaneConfig,
  history: Schema.Array(ConversationMessage),
  attention: AttentionState
})
export type PaneRecord = typeof PaneRecord.Type

import { Schema } from 'effect'
import { AttentionState } from './attention'

/**
 * A single turn in a pane's conversation history, as exchanged with Claude.
 * Use to append to or read `PaneRecord.history`. `checkpointUuid`, when present,
 * is the Agent SDK message id anchoring a rewindable file checkpoint to this
 * user turn (see ADR-0018); absent on assistant turns and on user turns that
 * carry no checkpoint (e.g. tool results).
 */
export const ConversationMessage = Schema.Struct({
  role: Schema.Literal('user', 'assistant'),
  content: Schema.String,
  checkpointUuid: Schema.optional(Schema.String)
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
 * How much autonomy a pane's agent has over tool use. `default` prompts for
 * dangerous operations, `plan` plans without executing tools, `acceptEdits`
 * auto-accepts file edits, `auto` lets a model classifier approve/deny prompts,
 * and `dontAsk` denies anything not pre-approved instead of prompting. Maps
 * onto the Agent SDK's `permissionMode` query option and its live
 * `setPermissionMode`.
 */
export const PermissionMode = Schema.Literal('default', 'plan', 'acceptEdits', 'auto', 'dontAsk')
export type PermissionMode = typeof PermissionMode.Type

/**
 * The permission modes a pane may be *created* in: {@link PermissionMode}
 * without `plan`. A pane never starts in plan mode (the user only switches into
 * it mid-session), which guarantees there is always a non-plan mode to restore
 * when a plan is approved. Use for pane-creation inputs; use the full
 * {@link PermissionMode} for a live pane's current mode.
 */
export const StartupPermissionMode = Schema.Literal('default', 'acceptEdits', 'auto', 'dontAsk')
export type StartupPermissionMode = typeof StartupPermissionMode.Type

/**
 * The permission mode a pane's config falls back to when a persisted record
 * predates the field: `default`, the most conservative mode.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default'

/**
 * The configuration needed to start or restore a pane: its identity, working
 * directory, model, thinking level, permission mode, and optional worktree
 * binding. Pass this when creating a new pane or persisting/restoring one across
 * sessions. `thinkingLevel` and `permissionMode` default (to
 * {@link DEFAULT_THINKING_LEVEL} / {@link DEFAULT_PERMISSION_MODE}) when absent,
 * so records persisted before they existed still decode.
 */
export const PaneConfig = Schema.Struct({
  paneId: Schema.UUID,
  cwd: Schema.String,
  model: Schema.String,
  thinkingLevel: Schema.optionalWith(ThinkingLevel, { default: () => DEFAULT_THINKING_LEVEL }),
  permissionMode: Schema.optionalWith(PermissionMode, { default: () => DEFAULT_PERMISSION_MODE }),
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

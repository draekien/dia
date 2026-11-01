import { Schema } from 'effect'

/**
 * Where one setup step of a tab stands. `warning` is only used by the copy step: the tab still
 * starts, but some files were not copied.
 */
export const SetupStepState = Schema.Literals(['pending', 'running', 'done', 'warning', 'failed'])
export type SetupStepState = typeof SetupStepState.Type

/**
 * The step that creates a tab's worktree, or reattaches it on resume when `reattach` is true.
 * `branch` is set once the worktree exists, `durationMs` once the step has finished, and `error`
 * when it failed.
 */
export const WorktreeSetupStep = Schema.TaggedStruct('WorktreeSetupStep', {
  reattach: Schema.Boolean,
  state: SetupStepState,
  branch: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String)
})
export type WorktreeSetupStep = typeof WorktreeSetupStep.Type

/** One file the copy step copies: its repo-relative `path`, and `error` when it was not copied. */
export const SetupFile = Schema.Struct({
  path: Schema.String,
  error: Schema.optional(Schema.String)
})
export type SetupFile = typeof SetupFile.Type

/**
 * The step that copies the files `.worktreeinclude` matches into the worktree. `files` lists
 * every matched file. `matchError` is set when the files could not be matched, and nothing was
 * copied. Present only when the project has a `.worktreeinclude`.
 */
export const CopySetupStep = Schema.TaggedStruct('CopySetupStep', {
  state: SetupStepState,
  files: Schema.Array(SetupFile),
  durationMs: Schema.optional(Schema.Finite),
  matchError: Schema.optional(Schema.String)
})
export type CopySetupStep = typeof CopySetupStep.Type

/** The step that starts the tab's Claude Code session; `error` is set when it failed. */
export const SessionSetupStep = Schema.TaggedStruct('SessionSetupStep', {
  state: SetupStepState,
  durationMs: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String)
})
export type SessionSetupStep = typeof SessionSetupStep.Type

/** One step of setting up a worktree tab, in the order the steps run. */
export const SetupStep = Schema.Union([WorktreeSetupStep, CopySetupStep, SessionSetupStep])
export type SetupStep = typeof SetupStep.Type

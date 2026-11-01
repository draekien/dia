import { Schema } from 'effect'

/**
 * A stored project the Host could not load: it stays in `host.db` until the user deletes it.
 * `agents` counts the stored agents it holds, which are not loaded either; `reason` is the decode
 * issue.
 */
export const UnreadableProject = Schema.TaggedStruct('UnreadableProject', {
  projectId: Schema.String,
  name: Schema.String,
  agents: Schema.Finite,
  reason: Schema.String
})
export type UnreadableProject = typeof UnreadableProject.Type

/**
 * A stored agent of a loaded project that the Host could not load: it stays in `host.db` until
 * the user deletes it. `project` is its project's display name; `reason` is the decode issue.
 */
export const UnreadableAgent = Schema.TaggedStruct('UnreadableAgent', {
  agentId: Schema.String,
  name: Schema.String,
  project: Schema.String,
  reason: Schema.String
})
export type UnreadableAgent = typeof UnreadableAgent.Type

/** A session id or worktree path, and the name of the stored agent that holds it. */
export const HeldValue = Schema.Struct({ value: Schema.String, heldBy: Schema.String })
export type HeldValue = typeof HeldValue.Type

/**
 * A tab of the imported `workspace.json` that the import skipped because it shared a session id or
 * worktree path with an earlier tab. `session` and `worktree` are present while a stored agent
 * holds that value; importing the tab drops each present one.
 */
export const ImportConflict = Schema.TaggedStruct('ImportConflict', {
  agentId: Schema.String,
  name: Schema.String,
  project: Schema.String,
  session: Schema.optional(HeldValue),
  worktree: Schema.optional(HeldValue)
})
export type ImportConflict = typeof ImportConflict.Type

/** One workspace problem the user can resolve: an unreadable stored row, or an import conflict. */
export const WorkspaceProblem = Schema.Union([UnreadableProject, UnreadableAgent, ImportConflict])
export type WorkspaceProblem = typeof WorkspaceProblem.Type

/** What the user decided for an {@link ImportConflict}: import it without its held values, or discard it. */
export const ImportResolution = Schema.Literals(['import', 'discard'])
export type ImportResolution = typeof ImportResolution.Type

/** The stored row of an {@link UnreadableProject} (`project`) or {@link UnreadableAgent} (`agent`) to delete. */
export const UnreadableRow = Schema.Struct({
  kind: Schema.Literals(['project', 'agent']),
  id: Schema.String
})
export type UnreadableRow = typeof UnreadableRow.Type

/** A workspace problem could not be listed or resolved; `reason` is the text to show the user. */
export class WorkspaceProblemError extends Schema.TaggedError<WorkspaceProblemError>()(
  'WorkspaceProblemError',
  { reason: Schema.String }
) {}

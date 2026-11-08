import { Schema } from 'effect'
import { PaneConfig } from './pane'
import { ProjectId } from './project'

/**
 * A session a host plugin attached to the Host, as the renderer shows it (ADR-0070, ADR-0071): a
 * row named `label`, with `caption` beside it, in the group of project `projectId`, or in the
 * `Assistant` group above the projects when `projectId` is null. `resettable` is true when the
 * user can replace the session with a fresh one through `ResetAttachedSession`. `config.paneId`
 * names it wherever a tab's pane id does; it is never a workspace tab. Read the list with
 * `GetAttachedSessions` and follow `AttachedSessionsChanged`.
 */
export const AttachedSession = Schema.Struct({
  config: PaneConfig,
  projectId: Schema.NullOr(ProjectId),
  label: Schema.NonEmptyString,
  caption: Schema.String,
  resettable: Schema.Boolean
})
export type AttachedSession = typeof AttachedSession.Type

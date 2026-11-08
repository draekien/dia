import { Schema } from 'effect'
import { PaneConfig } from './pane'
import { ProjectId } from './project'

/**
 * A session a host plugin attached to the Host, as the renderer shows it (ADR-0070): a row named
 * `label`, with `caption` beside it, in the group of project `projectId`. `config.paneId` names it
 * wherever a tab's pane id does; it is never a workspace tab. Read the list with
 * `GetAttachedSessions` and follow `AttachedSessionsChanged`.
 */
export const AttachedSession = Schema.Struct({
  config: PaneConfig,
  projectId: ProjectId,
  label: Schema.NonEmptyString,
  caption: Schema.String
})
export type AttachedSession = typeof AttachedSession.Type

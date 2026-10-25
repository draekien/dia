import { Option, Schema } from 'effect'
import { PaneConfig, SessionId } from './pane'
import { Uuid } from './uuid'

/** Id of a registered project. Create one with `crypto.randomUUID()` on the client that registers it. */
export const ProjectId = Uuid.pipe(Schema.brand('ProjectId'))
export type ProjectId = typeof ProjectId.Type

/**
 * The name an agent shows in the overview and the content header. Decode trimmed input: the
 * schema rejects leading or trailing spaces rather than removing them.
 */
export const AgentName = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  Schema.brand('AgentName')
)
export type AgentName = typeof AgentName.Type

/**
 * A directory the user registered with dia (ADR-0023). `directory` is the path as first
 * registered; `directoryKey` is the comparison key the Host computed for it, so two spellings of
 * one directory cannot both be registered. `isGitRepo` decides whether worktree features apply.
 */
export const Project = Schema.Struct({
  projectId: ProjectId,
  directory: Schema.String,
  directoryKey: Schema.String,
  displayName: Schema.String,
  isGitRepo: Schema.Boolean
})
export type Project = typeof Project.Type

/**
 * One agent in a project (ADR-0023). Its pane id is `config.paneId`. `archived` tabs stay in the
 * project's archived list and are never the visible tab.
 */
export const Tab = Schema.Struct({
  name: AgentName,
  config: PaneConfig,
  sessionId: Schema.optional(SessionId),
  archived: Schema.Boolean
})
export type Tab = typeof Tab.Type

/** A project with its tabs, in the order the overview lists them. */
export const ProjectEntry = Schema.Struct({
  project: Project,
  tabs: Schema.Array(Tab)
})
export type ProjectEntry = typeof ProjectEntry.Type

const paneIdsOf = (projects: ReadonlyArray<ProjectEntry>): ReadonlyArray<string> =>
  projects.flatMap((entry) => entry.tabs.map((tab) => tab.config.paneId))

const hasDuplicates = (values: ReadonlyArray<string>): boolean =>
  new Set(values).size !== values.length

/**
 * Every registered project with its tabs, in the user's project order, and the tab the content
 * area shows. Decoding rejects two projects with one `directoryKey`, two tabs with one pane id,
 * and a `visibleTab` that names no tab or an archived one. `visibleTab` is `none` while the
 * content area shows no tab.
 */
export const Workspace = Schema.Struct({
  projects: Schema.Array(ProjectEntry),
  visibleTab: Schema.OptionFromNullOr(Uuid)
}).check(
  Schema.makeFilter((workspace) =>
    hasDuplicates(workspace.projects.map((entry) => entry.project.directoryKey))
      ? 'two projects share a directory'
      : undefined
  ),
  Schema.makeFilter((workspace) =>
    hasDuplicates(paneIdsOf(workspace.projects)) ? 'two tabs share a pane id' : undefined
  ),
  Schema.makeFilter((workspace) => {
    if (workspace.visibleTab._tag === 'None') return undefined
    const paneId = workspace.visibleTab.value
    const tab = workspace.projects
      .flatMap((entry) => entry.tabs)
      .find((candidate) => candidate.config.paneId === paneId)
    if (tab === undefined) return 'the visible tab is not in the workspace'
    return tab.archived ? 'the visible tab is archived' : undefined
  })
)
export type Workspace = typeof Workspace.Type

/** The workspace before the user registers any project. */
export const EMPTY_WORKSPACE: Workspace = Workspace.make({
  projects: [],
  visibleTab: Option.none()
})

/** `registerProject` refused a directory whose `directoryKey` another project already has. */
export class ProjectAlreadyRegisteredError extends Schema.TaggedError<ProjectAlreadyRegisteredError>()(
  'ProjectAlreadyRegisteredError',
  { directory: Schema.String }
) {}

/** `registerProject` was given a path that is not an existing directory. */
export class DirectoryNotFoundError extends Schema.TaggedError<DirectoryNotFoundError>()(
  'DirectoryNotFoundError',
  { directory: Schema.String }
) {}

/** An operation named a project that is not registered, or is being removed. */
export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  'ProjectNotFoundError',
  { projectId: Schema.String }
) {}

/** An operation named a pane id that no tab has, or whose project is being removed. */
export class TabNotFoundError extends Schema.TaggedError<TabNotFoundError>()('TabNotFoundError', {
  paneId: Schema.String
}) {}

/** `createTab` asked for a worktree in a project that is not a git repo. */
export class WorktreeUnavailableError extends Schema.TaggedError<WorktreeUnavailableError>()(
  'WorktreeUnavailableError',
  { projectId: Schema.String }
) {}

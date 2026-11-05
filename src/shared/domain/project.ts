import { Schema } from 'effect'
import { PaneConfig, SessionId, StartupPermissionMode, ThinkingLevel } from './pane'
import { Uuid } from './uuid'

/** Id of a registered project. Create one with `crypto.randomUUID()` on the client that registers it. */
export const ProjectId = Uuid.pipe(Schema.brand('ProjectId'))
export type ProjectId = typeof ProjectId.Type

/** The most characters an {@link AgentName} has. */
export const AGENT_NAME_MAX_LENGTH = 64

/**
 * The name an agent shows in the overview and the content header. Decode trimmed input: the
 * schema rejects leading or trailing spaces rather than removing them.
 */
export const AgentName = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(AGENT_NAME_MAX_LENGTH)),
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
 * One agent in a project (ADR-0023). Its pane id is `config.paneId`. An `archived` tab is listed
 * in the project's archived list, has no worktree directory and never runs; showing it shows its
 * transcript read-only. It keeps `config.worktree`, so unarchiving it can restore the worktree.
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
 * and a `visibleTab` that names no tab. `visibleTab` is `null` while the
 * content area shows no tab. Every field is plain data, so a workspace crosses `contextBridge`
 * unchanged.
 */
export const Workspace = Schema.Struct({
  projects: Schema.Array(ProjectEntry),
  visibleTab: Schema.NullOr(Uuid)
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
    const paneId = workspace.visibleTab
    if (paneId === null) return undefined
    const tab = workspace.projects
      .flatMap((entry) => entry.tabs)
      .find((candidate) => candidate.config.paneId === paneId)
    return tab === undefined ? 'the visible tab is not in the workspace' : undefined
  })
)
export type Workspace = typeof Workspace.Type

/** The workspace before the user registers any project. */
export const EMPTY_WORKSPACE: Workspace = Workspace.make({
  projects: [],
  visibleTab: null
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

/**
 * A project was refused a directory because a stored project that could not be loaded already
 * has its `directoryKey`, or because the stored keys could not be read. The user resolves the
 * stored project under workspace problems first.
 */
export class StoredProjectUnreadableError extends Schema.TaggedError<StoredProjectUnreadableError>()(
  'StoredProjectUnreadableError',
  { directory: Schema.String }
) {}

/** Why `registerProject` refused a directory. */
export const RegisterProjectError = Schema.Union([
  ProjectAlreadyRegisteredError,
  DirectoryNotFoundError,
  StoredProjectUnreadableError
])
export type RegisterProjectError = typeof RegisterProjectError.Type

/**
 * A {@link RegisterProjectError} as plain data (`{ _tag, directory }`), the form in which it
 * crosses `contextBridge` to the renderer. Switch on `_tag`.
 */
export type RegisterProjectRefusal = typeof RegisterProjectError.Encoded

/** An operation named a project that is not registered, or is being removed. */
export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  'ProjectNotFoundError',
  { projectId: Schema.String }
) {}

/** An operation named a pane id that no tab has, or whose project is being removed. */
export class TabNotFoundError extends Schema.TaggedError<TabNotFoundError>()('TabNotFoundError', {
  paneId: Schema.String
}) {}

/**
 * Archiving or deleting a tab could not remove its worktree at `path`; `reason` says why. The tab
 * is left as it was, with its session stopped, so the request can be sent again.
 */
export class WorktreeNotRemovedError extends Schema.TaggedError<WorktreeNotRemovedError>()(
  'WorktreeNotRemovedError',
  { paneId: Schema.String, path: Schema.String, reason: Schema.String }
) {}

/**
 * Unarchiving a tab could not restore its working directory; `path` is the worktree path, or the
 * tab's `cwd` for a tab with no worktree, and `reason` says why. The tab stays archived and no
 * event is written, so the request can be sent again.
 */
export class WorktreeNotRestoredError extends Schema.TaggedError<WorktreeNotRestoredError>()(
  'WorktreeNotRestoredError',
  { paneId: Schema.String, path: Schema.String, reason: Schema.String }
) {}

/** `createTab` asked for a worktree in a project that is not a git repo. */
export class WorktreeUnavailableError extends Schema.TaggedError<WorktreeUnavailableError>()(
  'WorktreeUnavailableError',
  { projectId: Schema.String }
) {}

/**
 * What `createTab` needs to start an agent in a project. `name` is `null` for a generated name
 * (the worktree slug when `useWorktree` is set). `useWorktree` is refused for a project that is
 * not a git repo.
 */
export const CreateTabRequest = Schema.Struct({
  projectId: ProjectId,
  paneId: Uuid,
  name: Schema.NullOr(AgentName),
  model: Schema.String,
  thinkingLevel: ThinkingLevel,
  permissionMode: StartupPermissionMode,
  useWorktree: Schema.Boolean
})
export type CreateTabRequest = typeof CreateTabRequest.Type

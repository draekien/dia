import { Option, Result } from 'effect'
import type { PaneConfig, PaneId, SessionId } from './pane'
import {
  type AgentName,
  type Project,
  ProjectAlreadyRegisteredError,
  type ProjectEntry,
  type ProjectId,
  ProjectNotFoundError,
  type Tab,
  TabNotFoundError,
  type Workspace
} from './project'

const firstShowableTab = (entry: ProjectEntry | undefined): Option.Option<PaneId> =>
  Option.fromNullishOr(entry?.tabs.find((tab) => !tab.archived)?.config.paneId)

const indexOfProject = (workspace: Workspace, projectId: ProjectId): number =>
  workspace.projects.findIndex((entry) => entry.project.projectId === projectId)

const findTab = (workspace: Workspace, paneId: PaneId): Tab | undefined =>
  workspace.projects.flatMap((entry) => entry.tabs).find((tab) => tab.config.paneId === paneId)

const mapTab = (
  workspace: Workspace,
  paneId: PaneId,
  update: (tab: Tab) => Tab
): Result.Result<Workspace, TabNotFoundError> =>
  findTab(workspace, paneId) === undefined
    ? Result.fail(new TabNotFoundError({ paneId }))
    : Result.succeed({
        ...workspace,
        projects: workspace.projects.map((entry) => ({
          ...entry,
          tabs: entry.tabs.map((tab) => (tab.config.paneId === paneId ? update(tab) : tab))
        }))
      })

/**
 * Registers `project` at the end of the project order. Succeeds unchanged when a project with the
 * same `projectId` and `directoryKey` is already registered, so a resent request is harmless.
 * Fails when another project has the same `directoryKey`.
 */
export const addProject = (
  workspace: Workspace,
  project: Project
): Result.Result<Workspace, ProjectAlreadyRegisteredError> => {
  const existing = workspace.projects.find(
    (entry) => entry.project.directoryKey === project.directoryKey
  )
  if (existing === undefined) {
    return Result.succeed({
      ...workspace,
      projects: [...workspace.projects, { project, tabs: [] }]
    })
  }
  return existing.project.projectId === project.projectId
    ? Result.succeed(workspace)
    : Result.fail(new ProjectAlreadyRegisteredError({ directory: project.directory }))
}

/**
 * Moves a project to `toIndex` in the project order. An index past either end moves it to that
 * end.
 */
export const moveProject = (
  workspace: Workspace,
  projectId: ProjectId,
  toIndex: number
): Result.Result<Workspace, ProjectNotFoundError> => {
  const from = indexOfProject(workspace, projectId)
  if (from === -1) return Result.fail(new ProjectNotFoundError({ projectId }))
  const target = Math.min(Math.max(Math.trunc(toIndex), 0), workspace.projects.length - 1)
  const rest = workspace.projects.filter((_, index) => index !== from)
  return Result.succeed({
    ...workspace,
    projects: [...rest.slice(0, target), workspace.projects[from], ...rest.slice(target)]
  })
}

/**
 * Moves `visibleTab` off a project that is about to be removed: to the first non-archived tab of
 * the next project, else of the previous one, else `none`. Unchanged when the visible tab is in
 * another project. Call before closing the project's panes; {@link removeProject} applies it too.
 */
export const moveVisibleTabOff = (
  workspace: Workspace,
  projectId: ProjectId
): Result.Result<Workspace, ProjectNotFoundError> => {
  const index = indexOfProject(workspace, projectId)
  if (index === -1) return Result.fail(new ProjectNotFoundError({ projectId }))
  const visible = workspace.visibleTab
  const holdsVisible =
    Option.isSome(visible) &&
    workspace.projects[index].tabs.some((tab) => tab.config.paneId === visible.value)
  if (!holdsVisible) return Result.succeed(workspace)
  const next = firstShowableTab(workspace.projects[index + 1])
  return Result.succeed({
    ...workspace,
    visibleTab: Option.isSome(next) ? next : firstShowableTab(workspace.projects[index - 1])
  })
}

/** Drops a project and its tabs, moving `visibleTab` as {@link moveVisibleTabOff} does. */
export const removeProject = (
  workspace: Workspace,
  projectId: ProjectId
): Result.Result<Workspace, ProjectNotFoundError> =>
  Result.map(moveVisibleTabOff(workspace, projectId), (moved) => ({
    ...moved,
    projects: moved.projects.filter((entry) => entry.project.projectId !== projectId)
  }))

/**
 * Appends `tab` to a project and makes it the visible tab. When a tab with the same pane id
 * already exists, only makes that tab visible, so a resent request adds nothing.
 */
export const addTab = (
  workspace: Workspace,
  projectId: ProjectId,
  tab: Tab
): Result.Result<Workspace, ProjectNotFoundError> => {
  if (indexOfProject(workspace, projectId) === -1) {
    return Result.fail(new ProjectNotFoundError({ projectId }))
  }
  const visibleTab = tab.archived ? workspace.visibleTab : Option.some(tab.config.paneId)
  if (findTab(workspace, tab.config.paneId) !== undefined) {
    return Result.succeed({ ...workspace, visibleTab })
  }
  return Result.succeed({
    visibleTab,
    projects: workspace.projects.map((entry) =>
      entry.project.projectId === projectId ? { ...entry, tabs: [...entry.tabs, tab] } : entry
    )
  })
}

/** Renames the tab with `paneId`. */
export const renameTab = (
  workspace: Workspace,
  paneId: PaneId,
  name: AgentName
): Result.Result<Workspace, TabNotFoundError> =>
  mapTab(workspace, paneId, (tab) => ({ ...tab, name }))

/**
 * Sets the visible tab; `none` shows no tab. Fails for a pane id that no tab has, or an archived
 * tab.
 */
export const selectTab = (
  workspace: Workspace,
  paneId: Option.Option<PaneId>
): Result.Result<Workspace, TabNotFoundError> => {
  if (Option.isNone(paneId)) return Result.succeed({ ...workspace, visibleTab: paneId })
  const tab = findTab(workspace, paneId.value)
  return tab === undefined || tab.archived
    ? Result.fail(new TabNotFoundError({ paneId: paneId.value }))
    : Result.succeed({ ...workspace, visibleTab: paneId })
}

/** Replaces fields of a tab's config. The pane id cannot change. */
export const updateTabConfig = (
  workspace: Workspace,
  paneId: PaneId,
  patch: Partial<Omit<PaneConfig, 'paneId'>>
): Result.Result<Workspace, TabNotFoundError> =>
  mapTab(workspace, paneId, (tab) => ({ ...tab, config: { ...tab.config, ...patch, paneId } }))

/** Stores the agent session id a tab resumes from. */
export const recordSession = (
  workspace: Workspace,
  paneId: PaneId,
  sessionId: SessionId
): Result.Result<Workspace, TabNotFoundError> =>
  mapTab(workspace, paneId, (tab) => ({ ...tab, sessionId }))

/** The tab with `paneId` and the project that holds it. */
export const tabOf = (
  workspace: Workspace,
  paneId: PaneId
): Result.Result<{ readonly project: Project; readonly tab: Tab }, TabNotFoundError> => {
  for (const entry of workspace.projects) {
    const tab = entry.tabs.find((candidate) => candidate.config.paneId === paneId)
    if (tab !== undefined) return Result.succeed({ project: entry.project, tab })
  }
  return Result.fail(new TabNotFoundError({ paneId }))
}

/**
 * The workspace as it is shown after loading: when no tab is visible, the first non-archived tab
 * becomes visible. Unchanged when a tab is visible or there is no tab to show.
 */
export const withDefaultVisibleTab = (workspace: Workspace): Workspace => {
  if (Option.isSome(workspace.visibleTab)) return workspace
  const first = workspace.projects.flatMap((entry) => entry.tabs).find((tab) => !tab.archived)
    ?.config.paneId
  return first === undefined ? workspace : { ...workspace, visibleTab: Option.some(first) }
}

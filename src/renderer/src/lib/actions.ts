import type { PaneId } from '@shared/domain/pane'
import { type AgentName, ProjectId, type RegisterProjectRefusal } from '@shared/domain/project'
import type { RemovalProgress } from '@shared/domain/project-removal'
import { Effect, Option } from 'effect'
import { openSettings } from '../components/settings/open-settings'
import { openNewAgentForm } from './view'
import { appRegistry, newAgentFormAtom, workspaceAtom } from './workspace-atoms'

const log = (message: string, annotations: Record<string, unknown>): void =>
  Effect.runSync(Effect.logDebug(message, annotations))

const visibleTab = (): PaneId | null =>
  Option.match(appRegistry.get(workspaceAtom), {
    onNone: () => null,
    onSome: (workspace) => workspace.visibleTab
  })

/** Shows tab `paneId` in the content area, closing the New agent form if it is open. */
export const selectTab = (paneId: PaneId): void => {
  log('Selecting a tab', { paneId })
  appRegistry.set(newAgentFormAtom, Option.none())
  window.dia.selectTab(paneId)
}

/** Opens the New agent form for project `projectId` in the content area. */
export const newAgent = (projectId: ProjectId): void => {
  log('Opening the New agent form', { projectId })
  const form = openNewAgentForm(appRegistry.get(newAgentFormAtom), projectId, visibleTab())
  appRegistry.set(newAgentFormAtom, Option.some(form))
  window.dia.selectTab(null)
}

/** Closes the New agent form and shows the tab that was visible when it opened. */
export const cancelNewAgent = (): void => {
  const form = appRegistry.get(newAgentFormAtom)
  appRegistry.set(newAgentFormAtom, Option.none())
  if (Option.isSome(form) && form.value.shownBefore !== null) {
    window.dia.selectTab(form.value.shownBefore)
  }
}

/**
 * Opens the directory picker and registers the chosen directory as a project. Resolves
 * `undefined` when the user cancels the picker, `null` once the project is registered, or the
 * {@link RegisterProjectRefusal} when the Host refused the directory.
 */
export const registerProject = (): Promise<RegisterProjectRefusal | null | undefined> =>
  window.dia.pickDirectory().then((directory) => {
    if (directory === null) return undefined
    log('Registering a project', { directory })
    // @effect-diagnostics-next-line cryptoRandomUUID:off -- a React action outside any Effect; the id only has to be unique.
    return window.dia.registerProject(ProjectId.make(crypto.randomUUID()), directory)
  })

/** Moves project `projectId` to position `toIndex` in the project order. */
export const moveProject = (projectId: ProjectId, toIndex: number): void => {
  log('Moving a project', { projectId, toIndex })
  window.dia.moveProject(projectId, toIndex)
}

/** Resumes the parked agent in tab `paneId`; does nothing when it is not parked. */
export const resumeParkedAgent = (paneId: PaneId): void => {
  log('Resuming a parked agent', { paneId })
  window.dia.resumeParkedAgent(paneId)
}

/** Renames tab `paneId` to `name`. */
export const renameTab = (paneId: PaneId, name: AgentName): void => {
  log('Renaming a tab', { paneId, name })
  window.dia.renameTab(paneId, name)
}

/**
 * Removes project `projectId`: closes its agents and, unless `force`, deletes their worktrees and
 * transcripts. `onProgress` receives each step. Resolves once the project is gone; rejects when
 * the connection to the Host drops.
 */
export const removeProject = (
  projectId: ProjectId,
  force: boolean,
  onProgress: (progress: RemovalProgress) => void
): Promise<void> => {
  log('Removing a project', { projectId, force })
  return window.dia.removeProject(projectId, force, onProgress)
}

/** Shows the project directory `directory` in the system file manager. */
export const revealProject = (directory: string): Promise<void> => window.dia.revealPath(directory)

/** Opens the Settings dialog on its Plugins page. */
export const openPluginsPage = (): void => openSettings({ page: 'plugins' })

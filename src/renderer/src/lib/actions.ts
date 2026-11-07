import type { PaneId } from '@shared/domain/pane'
import { type AgentName, ProjectId, type RegisterProjectRefusal } from '@shared/domain/project'
import type { RemovalProgress } from '@shared/domain/project-removal'
import { sameEntryKey } from '@shared/plugin/list-slot'
import { Effect, Option } from 'effect'
import { openSettings } from '../components/settings/open-settings'
import { openNewAgentForm, type PageKey } from './view'
import { appRegistry, newAgentFormAtom, openPageAtom, workspaceAtom } from './workspace-atoms'

const log = (message: string, annotations: Record<string, unknown>): void =>
  Effect.runSync(Effect.logDebug(message, annotations))

const visibleTab = (): PaneId | null =>
  Option.match(appRegistry.get(workspaceAtom), {
    onNone: () => null,
    onSome: (workspace) => workspace.visibleTab
  })

const tabHiddenByPage = (): PaneId | null =>
  Option.match(appRegistry.get(openPageAtom), {
    onNone: visibleTab,
    onSome: (page) => page.shownBefore
  })

/** Shows tab `paneId` in the content area, closing the New agent form or page if one is open. */
export const selectTab = (paneId: PaneId): void => {
  log('Selecting a tab', { paneId })
  appRegistry.set(newAgentFormAtom, Option.none())
  appRegistry.set(openPageAtom, Option.none())
  window.dia.selectTab(paneId)
}

/** Opens the New agent form for project `projectId` in the content area. */
export const newAgent = (projectId: ProjectId): void => {
  log('Opening the New agent form', { projectId })
  const form = openNewAgentForm(appRegistry.get(newAgentFormAtom), projectId, tabHiddenByPage())
  appRegistry.set(openPageAtom, Option.none())
  appRegistry.set(newAgentFormAtom, Option.some(form))
  window.dia.selectTab(null)
}

/**
 * Shows the page `key` names in the content area, closing the New agent form if it is open. No tab
 * is visible while the page shows; selecting a tab closes it.
 */
export const openPage = (key: PageKey): void => {
  log('Opening a page', { plugin: key.plugin, id: key.id })
  const shownBefore = Option.match(appRegistry.get(newAgentFormAtom), {
    onNone: tabHiddenByPage,
    onSome: (form) => form.shownBefore
  })
  appRegistry.set(newAgentFormAtom, Option.none())
  appRegistry.set(openPageAtom, Option.some({ key, shownBefore }))
  window.dia.selectTab(null)
}

/**
 * Closes the page `key` names if it is the open page, and shows the tab that was visible when it
 * opened. Does nothing when another page, or no page, is open.
 */
export const closePage = (key: PageKey): void => {
  const open = appRegistry.get(openPageAtom)
  if (Option.isNone(open) || !sameEntryKey(open.value.key, key)) return
  log('Closing a page', { plugin: key.plugin, id: key.id })
  appRegistry.set(openPageAtom, Option.none())
  if (open.value.shownBefore !== null) window.dia.selectTab(open.value.shownBefore)
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
 * Archives tab `paneId`: stops its agent and removes its worktree; its branch and transcripts
 * stay, and the tab moves to its project's archived list. Resolves `null` once archived, or the
 * reason the worktree could not be removed, in which case the tab is left as it was.
 */
export const archiveTab = (paneId: PaneId): Promise<string | null> => {
  log('Archiving a tab', { paneId })
  return window.dia.archiveTab(paneId)
}

/**
 * Deletes tab `paneId`: stops its agent, removes its worktree and dia's records of it; its branch
 * and transcripts stay. Resolves as {@link archiveTab} does.
 */
export const deleteTab = (paneId: PaneId): Promise<string | null> => {
  log('Deleting a tab', { paneId })
  return window.dia.deleteTab(paneId)
}

/**
 * Unarchives tab `paneId`: restores its worktree from its kept branch and moves it out of its
 * project's archived list; starts no session. Resolves `null` once unarchived, or the reason its
 * working directory could not be restored, in which case the tab stays archived.
 */
export const unarchiveTab = (paneId: PaneId): Promise<string | null> => {
  log('Unarchiving a tab', { paneId })
  return window.dia.unarchiveTab(paneId)
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
export const openPluginsPage = (): void => openSettings({ plugin: 'settings', id: 'plugins' })

import type { PaneId } from '@shared/domain/pane'
import {
  type AgentName,
  type Project,
  ProjectId,
  type RegisterProjectRefusal,
  type Workspace
} from '@shared/domain/project'
import type { RemovalProgress } from '@shared/domain/project-removal'
import { Uuid } from '@shared/domain/uuid'
import { tabOf, userProjects } from '@shared/domain/workspace'
import { sameEntryKey } from '@shared/plugin/list-slot'
import { Effect, Option, Result } from 'effect'
import { openSettings } from '../components/settings/open-settings'
import {
  type Draft,
  draftsAtom,
  emptyDraft,
  lastTargetAtom,
  ProjectTarget,
  sameTarget,
  type ThreadTarget,
  withDraft,
  withoutDraft
} from './drafts'
import { openNewThreadForm, type PageKey } from './view'
import { appRegistry, newThreadFormAtom, openPageAtom, workspaceAtom } from './workspace-atoms'

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

const shownBeforeOpening = (): PaneId | null =>
  Option.match(appRegistry.get(newThreadFormAtom), {
    onNone: tabHiddenByPage,
    onSome: (form) => form.shownBefore
  })

/** Shows tab `paneId` in the content area, closing the new-thread page or page if one is open. */
export const selectTab = (paneId: PaneId): void => {
  log('Selecting a tab', { paneId })
  appRegistry.set(newThreadFormAtom, Option.none())
  appRegistry.set(openPageAtom, Option.none())
  window.dia.selectTab(paneId)
}

/** Shows the new-thread page for draft `draftId` in the content area, closing any open page. */
export const openDraft = (draftId: Uuid): void => {
  log('Opening the new-thread page', { draftId })
  const form = openNewThreadForm(appRegistry.get(newThreadFormAtom), draftId, tabHiddenByPage())
  appRegistry.set(openPageAtom, Option.none())
  appRegistry.set(newThreadFormAtom, Option.some(form))
  window.dia.selectTab(null)
}

const projectTarget = (project: Project | undefined): ThreadTarget | null =>
  project === undefined ? null : ProjectTarget.make({ projectId: project.projectId })

const projectOfVisibleTab = (workspace: Workspace): ThreadTarget | null => {
  if (workspace.visibleTab === null) return null
  const found = tabOf(workspace, workspace.visibleTab)
  if (Result.isFailure(found) || found.success.project.owner !== undefined) return null
  return projectTarget(found.success.project)
}

const firstProject = (workspace: Workspace): ThreadTarget | null =>
  projectTarget(userProjects(workspace)[0]?.project)

/**
 * The target a new thread starts in when the user names none: the project of the visible tab,
 * else the target of the last thread sent, else the first project, else null.
 */
export const defaultThreadTarget = (): ThreadTarget | null => {
  const workspace = Option.getOrUndefined(appRegistry.get(workspaceAtom))
  const visible = workspace === undefined ? null : projectOfVisibleTab(workspace)
  const last = appRegistry.get(lastTargetAtom)
  return visible ?? last ?? (workspace === undefined ? null : firstProject(workspace))
}

/**
 * Opens the new-thread page for `target`, or for {@link defaultThreadTarget} when `target` is
 * absent. Reuses that target's saved draft that has no text, and otherwise saves a new empty draft.
 */
export const newThread = (target?: ThreadTarget): void => {
  const resolved = target ?? defaultThreadTarget()
  const drafts = appRegistry.get(draftsAtom)
  const reusable = drafts.find((draft) => draft.text === '' && sameTarget(draft.target, resolved))
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- a React action outside any Effect; the id only has to be unique.
  const draft = reusable ?? emptyDraft(Uuid.make(crypto.randomUUID()), resolved)
  if (reusable === undefined) appRegistry.set(draftsAtom, withDraft(drafts, draft))
  log('Starting a new thread', {
    draftId: draft.draftId,
    target: resolved,
    reused: reusable !== undefined
  })
  openDraft(draft.draftId)
}

/** Saves `draft`, replacing the saved draft with its id. */
export const saveDraft = (draft: Draft): void => {
  appRegistry.set(draftsAtom, withDraft(appRegistry.get(draftsAtom), draft))
}

const closeNewThreadPage = (draftId: Uuid): void => {
  const form = appRegistry.get(newThreadFormAtom)
  if (Option.isNone(form) || form.value.draftId !== draftId) return
  appRegistry.set(newThreadFormAtom, Option.none())
  if (form.value.shownBefore !== null) window.dia.selectTab(form.value.shownBefore)
}

/**
 * Deletes draft `draftId`. When its new-thread page is open, closes it and shows the tab that was
 * visible when it opened.
 */
export const discardDraft = (draftId: Uuid): void => {
  log('Discarding a draft', { draftId })
  appRegistry.set(draftsAtom, withoutDraft(appRegistry.get(draftsAtom), draftId))
  closeNewThreadPage(draftId)
}

/**
 * Records that draft `draftId` was sent as a thread in `target`: deletes the draft and makes
 * `target` the one {@link defaultThreadTarget} falls back to. Leaves the content area as it is.
 */
export const completeDraft = (draftId: Uuid, target: ThreadTarget): void => {
  log('Sent a draft', { draftId, target })
  appRegistry.set(draftsAtom, withoutDraft(appRegistry.get(draftsAtom), draftId))
  appRegistry.set(lastTargetAtom, target)
}

/**
 * Shows the page `key` names in the content area, passing it `key.target`, and closes the
 * new-thread page if it is open. No tab is visible while the page shows; selecting a tab closes it.
 */
export const openPage = (key: PageKey): void => {
  log('Opening a page', { plugin: key.plugin, id: key.id, target: key.target })
  const shownBefore = shownBeforeOpening()
  appRegistry.set(newThreadFormAtom, Option.none())
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

/** The sentence to show the user for each way the Host refuses a directory in {@link registerProject}. */
export const REGISTER_PROJECT_REFUSAL_TEXT: Record<RegisterProjectRefusal['_tag'], string> = {
  ProjectAlreadyRegisteredError: 'dia already has a project for that directory.',
  DirectoryNotFoundError: 'That directory no longer exists.',
  StoredProjectUnreadableError:
    'A stored project for that directory could not be loaded. Resolve it under workspace problems first.'
}

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
export const openPluginsPage = (): void => openSettings({ plugin: 'dia-settings', id: 'plugins' })

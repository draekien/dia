import { StartupPermissionMode, ThinkingLevel } from '@shared/domain/pane'
import { ProjectId, type Workspace, WorktreeStart } from '@shared/domain/project'
import { Uuid } from '@shared/domain/uuid'
import { PluginName } from '@shared/plugin/manifest'
import { Effect, Option, Schema } from 'effect'
import { Atom } from 'effect/reactivity'

/** A new thread that starts in project `projectId`. */
export const ProjectTarget = Schema.TaggedStruct('ProjectTarget', { projectId: ProjectId })
export type ProjectTarget = typeof ProjectTarget.Type

/** A new thread that plugin `plugin` takes as its thread target `id`, such as the Assistant. */
export const PluginThreadTarget = Schema.TaggedStruct('PluginThreadTarget', {
  plugin: PluginName,
  id: Schema.String
})
export type PluginThreadTarget = typeof PluginThreadTarget.Type

/** Where a new thread starts: a project, or a plugin's thread target. */
export const ThreadTarget = Schema.Union([ProjectTarget, PluginThreadTarget])
export type ThreadTarget = typeof ThreadTarget.Type

/**
 * A new thread the user has not sent yet. `target` is null while there is nowhere to start it (no
 * project is registered). `model`, `thinkingLevel` and `permissionMode` are null to use the agent
 * defaults. `worktree` is null to work in the project's checkout. `text` is the composer text.
 * `sentAs` is the pane id of the tab the last Send asked the Host to create, or null before a Send.
 */
export const Draft = Schema.Struct({
  draftId: Uuid,
  target: Schema.NullOr(ThreadTarget),
  text: Schema.String,
  model: Schema.NullOr(Schema.String),
  thinkingLevel: Schema.NullOr(ThinkingLevel),
  permissionMode: Schema.NullOr(StartupPermissionMode),
  worktree: Schema.NullOr(WorktreeStart),
  sentAs: Schema.NullOr(Uuid)
})
export type Draft = typeof Draft.Type

/** Whether `a` and `b` name the same thread target. */
export const sameTarget = (a: ThreadTarget | null, b: ThreadTarget | null): boolean => {
  if (a === null || b === null) return a === b
  if (a._tag === 'ProjectTarget') return b._tag === 'ProjectTarget' && a.projectId === b.projectId
  return b._tag === 'PluginThreadTarget' && a.plugin === b.plugin && a.id === b.id
}

/** A draft `draftId` for `target` with no text and every setting at its default. */
export const emptyDraft = (draftId: Uuid, target: ThreadTarget | null): Draft => ({
  draftId,
  target,
  text: '',
  model: null,
  thinkingLevel: null,
  permissionMode: null,
  worktree: null,
  sentAs: null
})

const DRAFTS_KEY = 'dia.drafts'
const LAST_TARGET_KEY = 'dia.drafts.lastTarget'

const log = (message: string, annotations?: Record<string, unknown>): void =>
  Effect.runSync(Effect.logDebug(message, annotations))

const decodeDrafts = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Draft)))
const decodeTarget = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadTarget))

const storedDrafts = (): ReadonlyArray<Draft> =>
  Option.getOrElse(decodeDrafts(localStorage.getItem(DRAFTS_KEY) ?? '[]'), () => [])

const chosenDraftsAtom = Atom.make<ReadonlyArray<Draft> | null>(null).pipe(Atom.keepAlive)

/**
 * Every saved draft, oldest first, kept across restarts. Set it to replace and persist the list;
 * prefer {@link saveDraft} and {@link removeDraft}.
 */
export const draftsAtom = Atom.writable(
  (get): ReadonlyArray<Draft> => get(chosenDraftsAtom) ?? storedDrafts(),
  (ctx, drafts: ReadonlyArray<Draft>) => {
    ctx.set(chosenDraftsAtom, drafts)
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  }
).pipe(Atom.keepAlive)

/** `drafts` with `draft` in place of the draft with its id, or appended when none has it. */
export const withDraft = (drafts: ReadonlyArray<Draft>, draft: Draft): ReadonlyArray<Draft> =>
  drafts.some((saved) => saved.draftId === draft.draftId)
    ? drafts.map((saved) => (saved.draftId === draft.draftId ? draft : saved))
    : [...drafts, draft]

/** `drafts` without the draft `draftId`. */
export const withoutDraft = (drafts: ReadonlyArray<Draft>, draftId: Uuid): ReadonlyArray<Draft> =>
  drafts.filter((draft) => draft.draftId !== draftId)

/** The drafts in `drafts` whose Send created a tab that `workspace` now holds. */
export const draftsSentTo = (
  drafts: ReadonlyArray<Draft>,
  workspace: Workspace
): ReadonlyArray<Draft> => {
  const paneIds = new Set(
    workspace.projects.flatMap((entry) => entry.tabs.map((tab) => tab.config.paneId))
  )
  return drafts.filter((draft) => draft.sentAs !== null && paneIds.has(draft.sentAs))
}

const chosenLastTargetAtom = Atom.make<Option.Option<ThreadTarget | null>>(Option.none()).pipe(
  Atom.keepAlive
)

/**
 * The target of the last thread the user sent, kept across restarts, or null before the first.
 * Set it to change and persist it.
 */
export const lastTargetAtom = Atom.writable(
  (get): ThreadTarget | null =>
    Option.getOrElse(get(chosenLastTargetAtom), () =>
      Option.getOrNull(decodeTarget(localStorage.getItem(LAST_TARGET_KEY) ?? ''))
    ),
  (ctx, target: ThreadTarget | null) => {
    ctx.set(chosenLastTargetAtom, Option.some(target))
    localStorage.setItem(LAST_TARGET_KEY, JSON.stringify(target))
    log('Saved the last thread target', { target })
  }
).pipe(Atom.keepAlive)

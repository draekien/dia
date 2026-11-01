import type { Tab } from '@shared/domain/project'
import {
  ImportConflict,
  type ImportResolution,
  type UnreadableRow,
  type WorkspaceProblem,
  WorkspaceProblemError
} from '@shared/domain/workspace-problem'
import { Context, type Crypto, Effect, type FileSystem, Layer, type Path, Schema } from 'effect'
import { PaneWorkspace } from './pane-workspace'
import { readSkippedImportTabs, type SkippedImportTab } from './workspace-import'
import { type Holders, WorkspaceStore } from './workspace-store'

/**
 * Service tag for the workspace problems the user resolves: stored projects and agents the Host
 * could not load, and tabs the legacy `workspace.json` import skipped. Provide it with
 * {@link makeWorkspaceProblemsLive}.
 */
export class WorkspaceProblems extends Context.Service<
  WorkspaceProblems,
  {
    /**
     * Every open problem: the unreadable stored projects and agents, then each skipped import tab
     * that was neither imported nor discarded and is not in the workspace. Fails with
     * {@link WorkspaceProblemError} when `host.db` cannot be read.
     */
    readonly list: Effect.Effect<ReadonlyArray<WorkspaceProblem>, WorkspaceProblemError>
    /**
     * Deletes an unreadable stored project or agent and the rows that cascade from it. A row the
     * workspace holds, or a missing row, is left alone. Fails with {@link WorkspaceProblemError}
     * when the delete fails.
     */
    readonly deleteUnreadable: (row: UnreadableRow) => Effect.Effect<void, WorkspaceProblemError>
    /**
     * Resolves the skipped import tab `agentId` for good: `import` adds it to the workspace without
     * the session id and worktree a stored agent holds, `discard` drops it. Either way it is never
     * listed again. An id that is not an open conflict is a no-op. Fails with
     * {@link WorkspaceProblemError} when `host.db` cannot be read or written, or the tab's project
     * is being removed.
     */
    readonly resolveImportConflict: (
      agentId: string,
      resolution: ImportResolution
    ) => Effect.Effect<void, WorkspaceProblemError>
  }
>()('WorkspaceProblems') {}

const HOST_DB_UNAVAILABLE = "dia could not read or write its workspace database. See dia's log."

const isProblemError = Schema.is(WorkspaceProblemError)

const asProblemError = (cause: unknown) =>
  isProblemError(cause) ? cause : new WorkspaceProblemError({ reason: HOST_DB_UNAVAILABLE })

const conflictOf = (skipped: SkippedImportTab, holders: Holders) => {
  const { tab, project } = skipped
  const sessionHolder =
    tab.sessionId === undefined ? undefined : holders.sessions.get(tab.sessionId)
  const worktree = tab.config.worktree
  const worktreeHolder = worktree === undefined ? undefined : holders.worktrees.get(worktree.path)
  return ImportConflict.make({
    agentId: tab.config.paneId,
    name: tab.name,
    project: project.displayName,
    ...(sessionHolder === undefined || tab.sessionId === undefined
      ? {}
      : { session: { value: tab.sessionId, heldBy: sessionHolder } }),
    ...(worktreeHolder === undefined || worktree === undefined
      ? {}
      : { worktree: { value: worktree.path, heldBy: worktreeHolder } })
  })
}

const withoutSession = ({ sessionId: _dropped, ...tab }: Tab): Tab => tab

const withoutWorktree = (tab: Tab): Tab => {
  const { worktree: _dropped, ...config } = tab.config
  return { ...tab, config }
}

const withoutHeldValues = (tab: Tab, conflict: ImportConflict): Tab => {
  const afterSession = conflict.session === undefined ? tab : withoutSession(tab)
  return conflict.worktree === undefined ? afterSession : withoutWorktree(afterSession)
}

/**
 * Builds the live {@link WorkspaceProblems}. `userDataPath` holds `workspace.imported.json`.
 * The file is read once, on the first call that needs it. Requires {@link WorkspaceStore},
 * {@link PaneWorkspace}, `FileSystem`, `Path` and `Crypto`.
 */
export const makeWorkspaceProblemsLive = (userDataPath: string) =>
  Layer.effect(
    WorkspaceProblems,
    Effect.gen(function* () {
      const store = yield* WorkspaceStore
      const workspace = yield* PaneWorkspace
      const files = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>()
      const readSkipped = yield* Effect.cached(
        readSkippedImportTabs(userDataPath).pipe(Effect.provideContext(files))
      )

      const openSkipped = Effect.gen(function* () {
        const skipped = yield* readSkipped
        if (skipped.length === 0) return skipped
        const closed = new Set(yield* store.resolvedImports)
        const current = yield* workspace.getWorkspace
        for (const entry of current.projects) {
          for (const tab of entry.tabs) closed.add(tab.config.paneId)
        }
        return skipped.filter((candidate) => !closed.has(candidate.tab.config.paneId))
      })

      const openConflicts = Effect.gen(function* () {
        const skipped = yield* openSkipped
        if (skipped.length === 0) return []
        const holders = yield* store.holders
        return skipped.map((candidate) => ({ candidate, conflict: conflictOf(candidate, holders) }))
      })

      const list = Effect.gen(function* () {
        const unreadable = yield* store.unreadable
        const conflicts = yield* openConflicts
        const problems: ReadonlyArray<WorkspaceProblem> = [
          ...unreadable,
          ...conflicts.map(({ conflict }) => conflict)
        ]
        yield* Effect.logDebug('Listed workspace problems', {
          unreadable: unreadable.length,
          conflicts: conflicts.length
        })
        return problems
      }).pipe(Effect.mapError(asProblemError), Effect.withSpan('WorkspaceProblems.list'))

      const deleteUnreadable = (row: UnreadableRow) =>
        store.deleteUnreadable(row).pipe(Effect.mapError(asProblemError))

      const resolveImportConflict = Effect.fn('WorkspaceProblems.resolveImportConflict')(function* (
        agentId: string,
        resolution: ImportResolution
      ) {
        const conflicts = yield* openConflicts
        const found = conflicts.find(({ conflict }) => conflict.agentId === agentId)
        if (found === undefined) {
          yield* Effect.logInfo('Found no open import conflict to resolve', { agentId })
          return
        }
        if (resolution === 'import') {
          const { candidate, conflict } = found
          yield* workspace
            .importTab(candidate.project, withoutHeldValues(candidate.tab, conflict))
            .pipe(
              Effect.mapError(
                () =>
                  new WorkspaceProblemError({
                    reason: 'Its project is being removed. Try again once it is gone.'
                  })
              )
            )
        }
        yield* store.recordImportResolution(agentId, resolution)
        yield* Effect.logInfo('Resolved an import conflict', {
          agentId,
          resolution,
          droppedSession: found.conflict.session !== undefined,
          droppedWorktree: found.conflict.worktree !== undefined
        })
      }, Effect.mapError(asProblemError))

      return WorkspaceProblems.of({ list, deleteUnreadable, resolveImportConflict })
    })
  )

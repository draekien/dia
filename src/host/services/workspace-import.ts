import { type ProjectEntry, Workspace } from '@shared/domain/project'
import { Effect, FileSystem, Option, Result, Schema } from 'effect'
import { LegacyWorkspace, migrateLegacyWorkspace } from './workspace-migration'

/**
 * The contents of a version 2 `workspace.json`: every project with its tabs, the project order and
 * the visible tab. Read only by {@link readLegacyWorkspace}; dia no longer writes the file.
 */
export const PersistedWorkspace = Schema.Struct({
  version: Schema.Literal(2),
  workspace: Workspace
})
export type PersistedWorkspace = typeof PersistedWorkspace.Type

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeCurrent = Schema.decodeUnknownResult(PersistedWorkspace)
const decodeLegacy = Schema.decodeUnknownResult(LegacyWorkspace)

const workspaceFile = (userDataPath: string) => `${userDataPath}/workspace.json`

const readJson = Effect.fn('WorkspaceImport.readJson')(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))
  if (!exists) return Option.none<unknown>()
  const raw = yield* fs.readFileString(filePath).pipe(Effect.option)
  if (Option.isNone(raw)) {
    yield* Effect.logWarning('Failed to read the workspace file; not importing it', { filePath })
    return Option.none<unknown>()
  }
  const parsed = parseJson(raw.value)
  if (Result.isFailure(parsed)) {
    yield* Effect.logWarning('Workspace file is not JSON; not importing it', { filePath })
    return Option.none<unknown>()
  }
  return Option.some(parsed.success)
})

const decodeWorkspace = Effect.fn('WorkspaceImport.decode')(function* (
  json: unknown,
  filePath: string
) {
  const current = decodeCurrent(json)
  if (Result.isSuccess(current)) return Option.some(current.success.workspace)
  const legacy = decodeLegacy(json)
  if (Result.isSuccess(legacy)) return Option.some(yield* migrateLegacyWorkspace(legacy.success))
  yield* Effect.logWarning('Workspace file is malformed; not importing it', {
    filePath,
    issue: current.failure
  })
  return Option.none<Workspace>()
})

const dropConflictingTabs = Effect.fn('WorkspaceImport.dropConflictingTabs')(function* (
  workspace: Workspace
) {
  const sessionIds = new Set<string>()
  const worktreePaths = new Set<string>()
  const dropped = new Set<string>()
  const projects: Array<ProjectEntry> = []
  for (const entry of workspace.projects) {
    const tabs = []
    for (const tab of entry.tabs) {
      const sessionTaken = tab.sessionId !== undefined && sessionIds.has(tab.sessionId)
      const worktree = tab.config.worktree
      const worktreeTaken = worktree !== undefined && worktreePaths.has(worktree.path)
      if (sessionTaken || worktreeTaken) {
        dropped.add(tab.config.paneId)
        yield* Effect.logWarning('Did not import a tab that shares a session or worktree', {
          name: tab.name,
          paneId: tab.config.paneId,
          sessionTaken,
          worktreeTaken
        })
        continue
      }
      if (tab.sessionId !== undefined) sessionIds.add(tab.sessionId)
      if (worktree !== undefined) worktreePaths.add(worktree.path)
      tabs.push(tab)
    }
    projects.push({ ...entry, tabs })
  }
  const visibleTab =
    workspace.visibleTab !== null && dropped.has(workspace.visibleTab) ? null : workspace.visibleTab
  return { projects, visibleTab }
})

/**
 * Reads the `workspace.json` an earlier version of dia left in `userDataPath`: version 2 as is,
 * version 1 converted to projects and tabs. A tab whose session id or worktree path an earlier tab
 * already holds is left out and logged. Returns `None`, and logs why, when the file is missing,
 * unreadable or malformed. Never fails and never changes the file; call {@link markImported} once
 * the result is stored.
 */
export const readLegacyWorkspace = Effect.fn('WorkspaceImport.read')(function* (
  userDataPath: string
) {
  const filePath = workspaceFile(userDataPath)
  const json = yield* readJson(filePath)
  if (Option.isNone(json)) return Option.none<Workspace>()
  const workspace = yield* decodeWorkspace(json.value, filePath)
  if (Option.isNone(workspace)) return workspace
  return Option.some<Workspace>(yield* dropConflictingTabs(workspace.value))
})

/**
 * Renames the imported `workspace.json` in `userDataPath` to `workspace.imported.json`, keeping the
 * original file. Call after the workspace read by {@link readLegacyWorkspace} is stored. A failure
 * is logged, not raised.
 */
export const markImported = Effect.fn('WorkspaceImport.markImported')(function* (
  userDataPath: string
) {
  const fs = yield* FileSystem.FileSystem
  const from = workspaceFile(userDataPath)
  const to = `${userDataPath}/workspace.imported.json`
  yield* fs.rename(from, to).pipe(
    Effect.andThen(Effect.logInfo('Imported the workspace file', { from, to })),
    Effect.catch((cause) =>
      Effect.logWarning('Could not rename the imported workspace file', { from, cause })
    )
  )
})

import type { SessionId } from '@shared/domain/pane'
import { Project, type ProjectEntry, Tab, type Workspace } from '@shared/domain/project'
import {
  UnreadableAgent,
  UnreadableProject,
  type UnreadableRow
} from '@shared/domain/workspace-problem'
import { Clock, Context, Data, Effect, Layer, Option, Ref, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { markImported, readLegacyWorkspace } from './workspace-import'

/** `host.db` could not be read, or an imported workspace could not be written to it. Carries the `SqlError`. */
export class WorkspaceLoadError extends Data.TaggedError('WorkspaceLoadError')<{
  readonly cause: unknown
}> {}

/** `save` could not write the workspace; nothing was applied. Carries the cause. */
export class WorkspaceWriteError extends Data.TaggedError('WorkspaceWriteError')<{
  readonly cause: unknown
}> {}

/**
 * Who holds each stored session id and worktree path: the name of the stored agent, including
 * agents `load` left out. A tab given one of these values for another agent makes `save` fail.
 */
export interface Holders {
  readonly sessions: ReadonlyMap<string, string>
  readonly worktrees: ReadonlyMap<string, string>
}

/** Service tag for the Host's persisted workspace. Provide it with {@link makeWorkspaceStoreLive}. */
export class WorkspaceStore extends Context.Service<
  WorkspaceStore,
  {
    /**
     * The saved workspace, or `None` when no workspace has been saved. Reads only. A stored project
     * or agent that does not decode is left out and logged, and stays stored untouched. Fails with
     * {@link WorkspaceLoadError} only when `host.db` cannot be read.
     */
    readonly load: Effect.Effect<Option.Option<Workspace>, WorkspaceLoadError>
    /**
     * Makes the stored workspace equal `workspace`, in one transaction. Unchanged projects and tabs
     * keep their rows, and a row is deleted only when its project or tab is gone from `workspace`,
     * so rows in other tables that reference an agent survive. Rows `load` left out are never
     * deleted or changed, except by the cascade when their project is removed. A tab whose
     * `sessionId` changed keeps its previous session as a superseded session. Fails with
     * {@link WorkspaceWriteError} when two tabs share a session id or worktree path, or the write
     * fails; nothing is applied then.
     */
    readonly save: (workspace: Workspace) => Effect.Effect<void, WorkspaceWriteError>
    /**
     * Every session id stored for any agent, current or superseded, including agents `load` left
     * out. A tab given one of these ids belonging to another agent makes `save` fail. Reads only.
     * Fails with {@link WorkspaceLoadError} when `host.db` cannot be read.
     */
    readonly sessionIds: Effect.Effect<ReadonlySet<SessionId>, WorkspaceLoadError>
    /**
     * Every stored project and agent `load` leaves out, with its decode issue as the reason. An
     * agent of a left-out project is not listed; its project counts it. Empty when no workspace
     * is stored. Reads only. Fails with {@link WorkspaceLoadError} when `host.db` cannot be read.
     */
    readonly unreadable: Effect.Effect<
      ReadonlyArray<UnreadableProject | UnreadableAgent>,
      WorkspaceLoadError
    >
    /**
     * Deletes a stored row `load` left out, with every row that cascades from it: a project's
     * agents, an agent's worktree and session records. A row `load` returned or `save` wrote, and a
     * missing row, are left alone. Fails with {@link WorkspaceWriteError} when the delete fails.
     */
    readonly deleteUnreadable: (row: UnreadableRow) => Effect.Effect<void, WorkspaceWriteError>
    /**
     * The stored {@link Holders} of session ids and worktree paths. Reads only. Fails with
     * {@link WorkspaceLoadError} when `host.db` cannot be read.
     */
    readonly holders: Effect.Effect<Holders, WorkspaceLoadError>
  }
>()('WorkspaceStore') {}

interface ProjectRow {
  readonly project_id: string
  readonly directory: string
  readonly directory_key: string
  readonly display_name: string
  readonly is_git_repo: number
}

interface AgentRow {
  readonly agent_id: string
  readonly project_id: string
  readonly name: string
  readonly archived: number
  readonly cwd: string
  readonly model: string
  readonly thinking_level: string
  readonly permission_mode: string
  readonly worktree_path: string | null
  readonly worktree_branch: string | null
  readonly worktree_source_repo: string | null
  readonly session_id: string | null
}

const decodeProject = Schema.decodeUnknownResult(Project, { reportInput: true })
const decodeTab = Schema.decodeUnknownResult(Tab, { reportInput: true })

const projectFromRow = (row: ProjectRow) =>
  decodeProject({
    projectId: row.project_id,
    directory: row.directory,
    directoryKey: row.directory_key,
    displayName: row.display_name,
    isGitRepo: row.is_git_repo === 1
  })

const tabFromRow = (row: AgentRow) =>
  decodeTab({
    name: row.name,
    archived: row.archived === 1,
    config: {
      paneId: row.agent_id,
      cwd: row.cwd,
      model: row.model,
      thinkingLevel: row.thinking_level,
      permissionMode: row.permission_mode,
      ...(row.worktree_path === null
        ? {}
        : {
            worktree: {
              path: row.worktree_path,
              branch: row.worktree_branch,
              sourceRepo: row.worktree_source_repo
            }
          })
    },
    ...(row.session_id === null ? {} : { sessionId: row.session_id })
  })

const tabsOf = (workspace: Workspace) => workspace.projects.flatMap((entry) => entry.tabs)

const sharedValue = (workspace: Workspace): Option.Option<string> => {
  const seen = new Set<string>()
  for (const tab of tabsOf(workspace)) {
    const keys = [
      ...(tab.sessionId === undefined ? [] : [`session ${tab.sessionId}`]),
      ...(tab.config.worktree === undefined ? [] : [`worktree ${tab.config.worktree.path}`])
    ]
    for (const key of keys) {
      if (seen.has(key)) return Option.some(key)
      seen.add(key)
    }
  }
  return Option.none()
}

interface KnownIds {
  readonly projects: ReadonlySet<string>
  readonly agents: ReadonlySet<string>
}

const idsOf = (workspace: Workspace): KnownIds => ({
  projects: new Set(workspace.projects.map((entry) => entry.project.projectId)),
  agents: new Set(tabsOf(workspace).map((tab) => tab.config.paneId))
})

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const knownRef = yield* Ref.make<KnownIds>({ projects: new Set(), agents: new Set() })

  const readRows = Effect.gen(function* () {
    const state = yield* sql<{
      readonly visible_agent: string | null
    }>`SELECT visible_agent FROM workspace_state WHERE id = 1`
    if (state.length === 0) return Option.none()
    const projects = yield* sql<ProjectRow>`
      SELECT project_id, directory, directory_key, display_name, is_git_repo
      FROM projects ORDER BY position`
    const agents = yield* sql<AgentRow>`
      SELECT a.agent_id, a.project_id, a.name, a.archived, a.cwd, a.model, a.thinking_level,
             a.permission_mode, w.path AS worktree_path, w.branch AS worktree_branch,
             w.source_repo AS worktree_source_repo, s.session_id
      FROM agents a
      LEFT JOIN agent_worktrees w ON w.agent_id = a.agent_id
      LEFT JOIN agent_sessions s ON s.agent_id = a.agent_id AND s.superseded_at IS NULL
      ORDER BY a.position`
    return Option.some({ visibleAgent: state[0].visible_agent, projects, agents })
  })

  const assemble = Effect.fn('WorkspaceStore.assemble')(function* (rows: {
    readonly visibleAgent: string | null
    readonly projects: ReadonlyArray<ProjectRow>
    readonly agents: ReadonlyArray<AgentRow>
  }) {
    const entries: Array<ProjectEntry> = []
    const unreadable: Array<UnreadableProject | UnreadableAgent> = []
    for (const row of rows.projects) {
      const agentRows = rows.agents.filter((agent) => agent.project_id === row.project_id)
      const project = projectFromRow(row)
      if (Result.isFailure(project)) {
        yield* Effect.logWarning('Left out a stored project that does not decode', {
          projectId: row.project_id,
          issue: project.failure
        })
        unreadable.push(
          UnreadableProject.make({
            projectId: row.project_id,
            name: row.display_name,
            agents: agentRows.length,
            reason: project.failure.message
          })
        )
        continue
      }
      const tabs: Array<Tab> = []
      for (const agentRow of agentRows) {
        const tab = tabFromRow(agentRow)
        if (Result.isFailure(tab)) {
          yield* Effect.logWarning('Left out a stored agent that does not decode', {
            agentId: agentRow.agent_id,
            issue: tab.failure
          })
          unreadable.push(
            UnreadableAgent.make({
              agentId: agentRow.agent_id,
              name: agentRow.name,
              project: project.success.displayName,
              reason: tab.failure.message
            })
          )
          continue
        }
        tabs.push(tab.success)
      }
      entries.push({ project: project.success, tabs })
    }
    const visible = entries
      .flatMap((entry) => entry.tabs)
      .find((tab) => tab.config.paneId === rows.visibleAgent)
    const workspace: Workspace = {
      projects: entries,
      visibleTab: visible === undefined ? null : visible.config.paneId
    }
    return { workspace, unreadable }
  })

  const load = Effect.gen(function* () {
    const rows = yield* readRows
    if (Option.isNone(rows)) {
      yield* Effect.logInfo('No stored workspace')
      return Option.none<Workspace>()
    }
    const { workspace } = yield* assemble(rows.value)
    yield* Ref.set(knownRef, idsOf(workspace))
    yield* Effect.logInfo('Loaded the stored workspace', {
      projects: workspace.projects.length,
      tabs: tabsOf(workspace).length
    })
    return Option.some(workspace)
  }).pipe(
    Effect.mapError((cause) => new WorkspaceLoadError({ cause })),
    Effect.withSpan('WorkspaceStore.load')
  )

  const deleteGone = Effect.fn('WorkspaceStore.deleteGone')(function* (
    workspace: Workspace,
    known: KnownIds
  ) {
    const present = idsOf(workspace)
    const projects = [...known.projects].filter((id) => !present.projects.has(id))
    const agents = [...known.agents].filter((id) => !present.agents.has(id))
    for (const id of projects) yield* sql`DELETE FROM projects WHERE project_id = ${id}`
    for (const id of agents) yield* sql`DELETE FROM agents WHERE agent_id = ${id}`
    return projects.length + agents.length
  })

  const upsertProjectsAndAgents = Effect.fn('WorkspaceStore.upsertProjectsAndAgents')(function* (
    workspace: Workspace
  ) {
    for (const [position, { project }] of workspace.projects.entries()) {
      yield* sql`INSERT INTO projects ${sql.insert({
        project_id: project.projectId,
        position,
        directory: project.directory,
        directory_key: project.directoryKey,
        display_name: project.displayName,
        is_git_repo: project.isGitRepo ? 1 : 0
      })} ON CONFLICT (project_id) DO UPDATE SET
        position = excluded.position, directory = excluded.directory,
        directory_key = excluded.directory_key, display_name = excluded.display_name,
        is_git_repo = excluded.is_git_repo`
    }
    for (const { project, tabs } of workspace.projects) {
      for (const [position, tab] of tabs.entries()) {
        yield* sql`INSERT INTO agents ${sql.insert({
          agent_id: tab.config.paneId,
          project_id: project.projectId,
          position,
          name: tab.name,
          archived: tab.archived ? 1 : 0,
          cwd: tab.config.cwd,
          model: tab.config.model,
          thinking_level: tab.config.thinkingLevel,
          permission_mode: tab.config.permissionMode
        })} ON CONFLICT (agent_id) DO UPDATE SET
          project_id = excluded.project_id, position = excluded.position, name = excluded.name,
          archived = excluded.archived, cwd = excluded.cwd, model = excluded.model,
          thinking_level = excluded.thinking_level, permission_mode = excluded.permission_mode`
      }
    }
  })

  const writeWorktrees = Effect.fn('WorkspaceStore.writeWorktrees')(function* (
    workspace: Workspace
  ) {
    const stored = yield* sql<{ readonly agent_id: string }>`SELECT agent_id FROM agent_worktrees`
    const withWorktree = new Set(stored.map((row) => row.agent_id))
    for (const tab of tabsOf(workspace)) {
      if (tab.config.worktree === undefined && withWorktree.has(tab.config.paneId)) {
        yield* sql`DELETE FROM agent_worktrees WHERE agent_id = ${tab.config.paneId}`
      }
    }
    for (const tab of tabsOf(workspace)) {
      const worktree = tab.config.worktree
      if (worktree === undefined) continue
      yield* sql`INSERT INTO agent_worktrees ${sql.insert({
        agent_id: tab.config.paneId,
        path: worktree.path,
        branch: worktree.branch,
        source_repo: worktree.sourceRepo
      })} ON CONFLICT (agent_id) DO UPDATE SET
        path = excluded.path, branch = excluded.branch, source_repo = excluded.source_repo`
    }
  })

  const writeSessions = Effect.fn('WorkspaceStore.writeSessions')(function* (
    workspace: Workspace,
    now: number
  ) {
    const stored = yield* sql<{
      readonly agent_id: string
      readonly session_id: string
    }>`SELECT agent_id, session_id FROM agent_sessions WHERE superseded_at IS NULL`
    const current = new Map(stored.map((row) => [row.agent_id, row.session_id]))
    const changed = tabsOf(workspace).filter(
      (tab) => current.get(tab.config.paneId) !== tab.sessionId
    )
    for (const tab of changed) {
      yield* sql`UPDATE agent_sessions SET superseded_at = ${now}
        WHERE agent_id = ${tab.config.paneId} AND superseded_at IS NULL`
    }
    for (const tab of changed) {
      if (tab.sessionId === undefined) continue
      const kept = yield* sql<{
        readonly session_id: string
      }>`INSERT INTO agent_sessions ${sql.insert({
        session_id: tab.sessionId,
        agent_id: tab.config.paneId,
        started_at: now,
        superseded_at: null
      })} ON CONFLICT (session_id) DO UPDATE SET superseded_at = NULL
        WHERE agent_id = excluded.agent_id
        RETURNING session_id`
      if (kept.length === 0) {
        return yield* new WorkspaceWriteError({
          cause: `Session ${tab.sessionId} belongs to another agent`
        })
      }
    }
    return changed.length
  })

  const write = Effect.fn('WorkspaceStore.write')(function* (
    workspace: Workspace,
    known: KnownIds,
    now: number
  ) {
    const deleted = yield* deleteGone(workspace, known)
    yield* upsertProjectsAndAgents(workspace)
    yield* writeWorktrees(workspace)
    const sessionChanges = yield* writeSessions(workspace, now)
    yield* sql`INSERT INTO workspace_state ${sql.insert({
      id: 1,
      visible_agent: workspace.visibleTab
    })} ON CONFLICT (id) DO UPDATE SET visible_agent = excluded.visible_agent`
    return { deleted, sessionChanges }
  })

  const save = Effect.fn('WorkspaceStore.save')(
    function* (workspace: Workspace) {
      const shared = sharedValue(workspace)
      if (Option.isSome(shared)) {
        return yield* new WorkspaceWriteError({ cause: `Two tabs share ${shared.value}` })
      }
      const now = yield* Clock.currentTimeMillis
      const known = yield* Ref.get(knownRef)
      const counts = yield* sql.withTransaction(write(workspace, known, now))
      yield* Ref.set(knownRef, idsOf(workspace))
      yield* Effect.logDebug('Saved the workspace', counts)
    },
    Effect.mapError((cause) =>
      cause instanceof WorkspaceWriteError ? cause : new WorkspaceWriteError({ cause })
    )
  )

  const unreadable = Effect.gen(function* () {
    const rows = yield* readRows
    if (Option.isNone(rows)) return []
    const { unreadable } = yield* assemble(rows.value)
    return unreadable
  }).pipe(
    Effect.mapError((cause) => new WorkspaceLoadError({ cause })),
    Effect.withSpan('WorkspaceStore.unreadable')
  )

  const deleteUnreadable = Effect.fn('WorkspaceStore.deleteUnreadable')(
    function* (row: UnreadableRow) {
      const known = yield* Ref.get(knownRef)
      const loaded = row.kind === 'project' ? known.projects : known.agents
      if (loaded.has(row.id)) {
        yield* Effect.logWarning('Refused to delete a stored row the workspace holds', row)
        return
      }
      if (row.kind === 'project') yield* sql`DELETE FROM projects WHERE project_id = ${row.id}`
      else yield* sql`DELETE FROM agents WHERE agent_id = ${row.id}`
      yield* Effect.logInfo('Deleted a stored row that could not be loaded', row)
    },
    Effect.mapError((cause) => new WorkspaceWriteError({ cause }))
  )

  const holders = Effect.gen(function* () {
    const sessions = yield* sql<{
      readonly session_id: string
      readonly name: string
    }>`SELECT s.session_id, a.name FROM agent_sessions s JOIN agents a ON a.agent_id = s.agent_id`
    const worktrees = yield* sql<{
      readonly path: string
      readonly name: string
    }>`SELECT w.path, a.name FROM agent_worktrees w JOIN agents a ON a.agent_id = w.agent_id`
    const result: Holders = {
      sessions: new Map(sessions.map((row) => [row.session_id, row.name])),
      worktrees: new Map(worktrees.map((row) => [row.path, row.name]))
    }
    return result
  }).pipe(
    Effect.mapError((cause) => new WorkspaceLoadError({ cause })),
    Effect.withSpan('WorkspaceStore.holders')
  )

  const hasWorkspace = Effect.map(
    sql`SELECT 1 FROM workspace_state WHERE id = 1`,
    (rows) => rows.length > 0
  )

  const sessionIds = sql<{
    readonly session_id: SessionId
  }>`SELECT session_id FROM agent_sessions`.pipe(
    Effect.map((rows): ReadonlySet<SessionId> => new Set(rows.map((row) => row.session_id))),
    Effect.mapError((cause) => new WorkspaceLoadError({ cause })),
    Effect.withSpan('WorkspaceStore.sessionIds')
  )

  return { load, save, sessionIds, unreadable, deleteUnreadable, holders, hasWorkspace }
})

const importLegacyWorkspace = Effect.fn('WorkspaceStore.importLegacyWorkspace')(function* (
  userDataPath: string,
  store: Effect.Success<typeof makeStore>
) {
  if (yield* store.hasWorkspace) return
  const imported = yield* readLegacyWorkspace(userDataPath)
  if (Option.isNone(imported)) return
  yield* store.save(imported.value)
  yield* markImported(userDataPath)
})

/**
 * Builds the live {@link WorkspaceStore} over `host.db`. When the database holds no workspace,
 * building it imports the `workspace.json` an earlier version of dia left in `userDataPath` and
 * keeps the original file as `workspace.imported.json`; a missing, unreadable or malformed file is
 * logged and left in place, and the store starts empty. A tab whose session id or worktree path an
 * earlier tab in the file already holds is not imported and is logged. Building fails with
 * {@link WorkspaceLoadError} only when `host.db` cannot be read or written. Requires `SqlClient`
 * (from `makeHostDatabaseLive`), `FileSystem`, `Path` and `Crypto`.
 */
export const makeWorkspaceStoreLive = (userDataPath: string) =>
  Layer.effect(
    WorkspaceStore,
    Effect.gen(function* () {
      const store = yield* makeStore
      yield* importLegacyWorkspace(userDataPath, store).pipe(
        Effect.mapError((cause) => new WorkspaceLoadError({ cause }))
      )
      return WorkspaceStore.of({
        load: store.load,
        save: store.save,
        sessionIds: store.sessionIds,
        unreadable: store.unreadable,
        deleteUnreadable: store.deleteUnreadable,
        holders: store.holders
      })
    })
  )

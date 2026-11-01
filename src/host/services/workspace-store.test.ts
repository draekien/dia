import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { SessionId } from '@shared/domain/pane'
import {
  AgentName,
  type ProjectEntry,
  ProjectId,
  type Tab,
  type Workspace
} from '@shared/domain/project'
import { Context, Effect, Exit, FileSystem, Layer, Option, Path, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { makeHostDatabaseLive } from './database'
import { directoryKey } from './project-directory'
import { makeWorkspaceStoreLive, WorkspaceStore } from './workspace-store'

const PANE_A = '11111111-1111-4111-8111-111111111111'
const PANE_B = '22222222-2222-4222-8222-222222222222'
const PANE_C = '33333333-3333-4333-8333-333333333333'
const PANE_PENDING = '44444444-4444-4444-8444-444444444444'
const PROJECT_X = ProjectId.make('55555555-5555-4555-8555-555555555555')
const PROJECT_Y = ProjectId.make('66666666-6666-4666-8666-666666666666')

const config = (paneId: string, cwd: string) => ({
  paneId,
  cwd,
  model: 'claude-sonnet-5-5',
  thinkingLevel: 'adaptive' as const,
  permissionMode: 'default' as const
})

const tab = (paneId: string, overrides: Partial<Tab> = {}): Tab => ({
  name: AgentName.make(`agent-${paneId.slice(0, 1)}`),
  config: config(paneId, 'F:\\x'),
  archived: false,
  ...overrides
})

const entry = (
  projectId: ProjectId,
  directory: string,
  tabs: ReadonlyArray<Tab>
): ProjectEntry => ({
  project: {
    projectId,
    directory,
    directoryKey: directory.toLowerCase(),
    displayName: directory,
    isGitRepo: true
  },
  tabs
})

const workspaceOf = (
  projects: ReadonlyArray<ProjectEntry>,
  visibleTab: string | null = null
): Workspace => ({ projects, visibleTab })

const oneTab = (overrides: Partial<Tab> = {}) =>
  workspaceOf([entry(PROJECT_X, 'F:\\x', [tab(PANE_A, overrides)])])

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: 'dia-workspace-store-' })
})

const openStore = (dir: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.provideMerge(
        makeWorkspaceStoreLive(dir),
        Layer.merge(makeHostDatabaseLive(dir), NodeServices.layer)
      )
    )
    return {
      store: Context.get(context, WorkspaceStore),
      sql: Context.get(context, SqlClient.SqlClient)
    }
  })

const inTempDir = <A, E>(
  body: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>
) =>
  Effect.gen(function* () {
    const dir = yield* tempDir
    return yield* body(dir)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const count = (sql: SqlClient.SqlClient, table: string) =>
  Effect.map(
    sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`,
    (rows) => rows[0].n
  )

const sessionRows = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly session_id: string
    readonly superseded_at: number | null
  }>`SELECT session_id, superseded_at FROM agent_sessions ORDER BY started_at, session_id`

describe('WorkspaceStore round trip', () => {
  it.effect('loads nothing from a fresh database with no workspace file', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* openStore(dir)

        assert.isTrue(Option.isNone(yield* store.load))
      })
    )
  )

  it.effect('writes one project row and one agent row for a project with one tab', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* openStore(dir)

        yield* store.save(oneTab())

        assert.deepStrictEqual([yield* count(sql, 'projects'), yield* count(sql, 'agents')], [1, 1])
      })
    )
  )

  it.effect('loads every project and tab field, the order and the visible tab after a reopen', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const workspace = workspaceOf(
          [
            {
              ...entry(PROJECT_Y, 'F:\\b', [
                tab(PANE_A, {
                  name: AgentName.make('heron'),
                  config: {
                    ...config(PANE_A, 'F:\\wt\\heron'),
                    model: 'claude-opus-5-5',
                    thinkingLevel: 'high',
                    permissionMode: 'acceptEdits',
                    worktree: { path: 'F:\\wt\\heron', branch: 'dia/heron', sourceRepo: 'F:\\b' }
                  },
                  sessionId: SessionId.make('s-1')
                }),
                tab(PANE_B, { archived: true })
              ]),
              project: { ...entry(PROJECT_Y, 'F:\\b', []).project, isGitRepo: false }
            },
            entry(PROJECT_X, 'F:\\a', [tab(PANE_C)])
          ],
          PANE_A
        )
        const first = yield* openStore(dir)
        yield* first.store.save(workspace)

        const second = yield* openStore(dir)

        assert.deepStrictEqual(yield* second.store.load, Option.some(workspace))
      })
    )
  )

  it.effect('loads the new project and tab order after a reorder', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* openStore(dir)
        yield* store.save(
          workspaceOf([
            entry(PROJECT_X, 'F:\\a', [tab(PANE_A), tab(PANE_B)]),
            entry(PROJECT_Y, 'F:\\b', [])
          ])
        )
        const reordered = workspaceOf([
          entry(PROJECT_Y, 'F:\\b', []),
          entry(PROJECT_X, 'F:\\a', [tab(PANE_B), tab(PANE_A)])
        ])

        yield* store.save(reordered)

        assert.deepStrictEqual(yield* store.load, Option.some(reordered))
      })
    )
  )
})

describe('WorkspaceStore sessions', () => {
  it.effect('lists superseded and current session ids', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* openStore(dir)
        yield* store.save(oneTab({ sessionId: SessionId.make('s-1') }))
        yield* store.save(oneTab({ sessionId: SessionId.make('s-2') }))

        assert.deepStrictEqual([...(yield* store.sessionIds)].sort(), ['s-1', 's-2'])
      })
    )
  )

  it.effect("refuses a new agent whose session is another agent's superseded session", () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* openStore(dir)
        yield* store.save(oneTab({ sessionId: SessionId.make('s-1') }))
        yield* store.save(oneTab({ sessionId: SessionId.make('s-2') }))
        const withSecondAgent = workspaceOf([
          entry(PROJECT_X, 'F:\\x', [
            tab(PANE_A, { sessionId: SessionId.make('s-2') }),
            tab(PANE_B, { sessionId: SessionId.make('s-1') })
          ])
        ])

        const error = yield* Effect.flip(store.save(withSecondAgent))

        assert.strictEqual(error._tag, 'WorkspaceWriteError')
      })
    )
  )

  it.effect('keeps the previous session as superseded at the time the session changed', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* openStore(dir)
        yield* store.save(oneTab({ sessionId: SessionId.make('s-1') }))
        yield* TestClock.adjust('1 second')

        yield* store.save(oneTab({ sessionId: SessionId.make('s-2') }))

        assert.deepStrictEqual(yield* sessionRows(sql), [
          { session_id: 's-1', superseded_at: 1000 },
          { session_id: 's-2', superseded_at: null }
        ])
      })
    )
  )

  it.effect('loads the newest session as the tab session after a change', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* openStore(dir)
        yield* store.save(oneTab({ sessionId: SessionId.make('s-1') }))
        yield* store.save(oneTab({ sessionId: SessionId.make('s-2') }))

        const loaded = Option.getOrThrow(yield* store.load)

        assert.strictEqual(loaded.projects[0].tabs[0].sessionId, 's-2')
      })
    )
  )

  it.effect('leaves no current session when the tab session is cleared', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* openStore(dir)
        yield* store.save(oneTab({ sessionId: SessionId.make('s-1') }))

        yield* store.save(oneTab())

        const rows = yield* sessionRows(sql)
        assert.deepStrictEqual(
          rows.map((row) => row.superseded_at !== null),
          [true]
        )
      })
    )
  )

  it.effect('refuses a save in which two tabs share a session id and applies nothing', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* openStore(dir)
        const shared = SessionId.make('s-1')

        const exit = yield* Effect.exit(
          store.save(
            workspaceOf([
              entry(PROJECT_X, 'F:\\x', [
                tab(PANE_A, { sessionId: shared }),
                tab(PANE_B, { sessionId: shared })
              ])
            ])
          )
        )

        assert.isTrue(Exit.isFailure(exit))
        assert.strictEqual(yield* count(sql, 'agents'), 0)
      })
    )
  )

  it.effect('refuses a session id that an earlier session of another agent holds', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* openStore(dir)
        const both = (a: string | undefined, b: string | undefined) =>
          workspaceOf([
            entry(PROJECT_X, 'F:\\x', [
              tab(PANE_A, a === undefined ? {} : { sessionId: SessionId.make(a) }),
              tab(PANE_B, b === undefined ? {} : { sessionId: SessionId.make(b) })
            ])
          ])
        yield* store.save(both('s-1', undefined))
        yield* store.save(both('s-2', undefined))

        const exit = yield* Effect.exit(store.save(both('s-2', 's-1')))

        assert.isTrue(Exit.isFailure(exit))
      })
    )
  )
})

describe('WorkspaceStore deletes', () => {
  it.effect('keeps a row that references a kept agent across a save', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* openStore(dir)
        yield* sql`CREATE TABLE notes (agent_id TEXT REFERENCES agents ON DELETE CASCADE)`
        yield* store.save(oneTab())
        yield* sql`INSERT INTO notes (agent_id) VALUES (${PANE_A})`

        yield* store.save(oneTab({ name: AgentName.make('renamed') }))

        assert.strictEqual(yield* count(sql, 'notes'), 1)
      })
    )
  )

  it.effect('deletes every row of a removed project', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* openStore(dir)
        yield* store.save(
          oneTab({
            config: {
              ...config(PANE_A, 'F:\\wt'),
              worktree: { path: 'F:\\wt', branch: 'dia/a', sourceRepo: 'F:\\x' }
            },
            sessionId: SessionId.make('s-1')
          })
        )

        yield* store.save(workspaceOf([]))

        const tables = ['projects', 'agents', 'agent_worktrees', 'agent_sessions']
        const counts = yield* Effect.forEach(tables, (table) => count(sql, table))
        assert.deepStrictEqual(counts, [0, 0, 0, 0])
      })
    )
  )

  it.effect('deletes every row of a deleted agent, superseded sessions included', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* openStore(dir)
        const deleted = (sessionId: string) =>
          tab(PANE_A, {
            config: {
              ...config(PANE_A, 'F:\\wt'),
              worktree: { path: 'F:\\wt', branch: 'dia/a', sourceRepo: 'F:\\x' }
            },
            sessionId: SessionId.make(sessionId)
          })
        yield* store.save(workspaceOf([entry(PROJECT_X, 'F:\\x', [deleted('s-1'), tab(PANE_B)])]))
        yield* store.save(workspaceOf([entry(PROJECT_X, 'F:\\x', [deleted('s-2'), tab(PANE_B)])]))

        yield* store.save(workspaceOf([entry(PROJECT_X, 'F:\\x', [tab(PANE_B)])]))

        const tables = ['projects', 'agents', 'agent_worktrees', 'agent_sessions']
        const counts = yield* Effect.forEach(tables, (table) => count(sql, table))
        assert.deepStrictEqual(counts, [1, 1, 0, 0])
      })
    )
  )

  it.effect('loads an archived visible tab as the visible tab after a reopen', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const workspace = workspaceOf(
          [entry(PROJECT_X, 'F:\\x', [tab(PANE_A), tab(PANE_B, { archived: true })])],
          PANE_B
        )
        yield* (yield* openStore(dir)).store.save(workspace)

        const loaded = yield* (yield* openStore(dir)).store.load

        assert.deepStrictEqual(loaded, Option.some(workspace))
      })
    )
  )

  it.effect('moves a worktree path from one tab to another in one save', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* openStore(dir)
        const worktree = { path: 'F:\\wt', branch: 'dia/w', sourceRepo: 'F:\\x' }
        const withWorktree = (paneId: string) => ({
          config: { ...config(paneId, 'F:\\wt'), worktree }
        })
        yield* store.save(
          workspaceOf([entry(PROJECT_X, 'F:\\x', [tab(PANE_A, withWorktree(PANE_A)), tab(PANE_B)])])
        )
        const moved = workspaceOf([
          entry(PROJECT_X, 'F:\\x', [tab(PANE_A), tab(PANE_B, withWorktree(PANE_B))])
        ])

        yield* store.save(moved)

        assert.deepStrictEqual(yield* store.load, Option.some(moved))
      })
    )
  )
})

describe('WorkspaceStore rows that do not decode', () => {
  const storeWithUnreadableTab = (dir: string) =>
    Effect.gen(function* () {
      const first = yield* openStore(dir)
      yield* first.store.save(workspaceOf([entry(PROJECT_X, 'F:\\x', [tab(PANE_A), tab(PANE_B)])]))
      yield* first.sql`UPDATE agents SET thinking_level = 'ultra' WHERE agent_id = ${PANE_B}`
      return yield* openStore(dir)
    })

  it.effect('leaves an agent with an unknown thinking level out of the loaded workspace', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* storeWithUnreadableTab(dir)

        const loaded = Option.getOrThrow(yield* store.load)

        assert.deepStrictEqual(
          loaded.projects[0].tabs.map((loadedTab) => loadedTab.config.paneId),
          [PANE_A]
        )
      })
    )
  )

  it.effect('keeps the unreadable agent row unchanged across a save', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* storeWithUnreadableTab(dir)
        yield* store.save(Option.getOrThrow(yield* store.load))

        const rows = yield* sql<{
          readonly thinking_level: string
        }>`SELECT thinking_level FROM agents WHERE agent_id = ${PANE_B}`

        assert.deepStrictEqual(rows, [{ thinking_level: 'ultra' }])
      })
    )
  )

  it.effect('deletes the unreadable agent row when its project is removed', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* storeWithUnreadableTab(dir)
        yield* store.load

        yield* store.save(workspaceOf([]))

        assert.strictEqual(yield* count(sql, 'agents'), 0)
      })
    )
  )
})

describe('WorkspaceStore unreadable rows', () => {
  const storeWithUnreadableTab = (dir: string) =>
    Effect.gen(function* () {
      const first = yield* openStore(dir)
      yield* first.store.save(workspaceOf([entry(PROJECT_X, 'F:\\x', [tab(PANE_A), tab(PANE_B)])]))
      yield* first.sql`UPDATE agents SET thinking_level = 'ultra' WHERE agent_id = ${PANE_B}`
      const reopened = yield* openStore(dir)
      yield* reopened.store.load
      return reopened
    })

  const storeWithUnreadableProject = (dir: string) =>
    Effect.gen(function* () {
      const first = yield* openStore(dir)
      yield* first.store.save(workspaceOf([entry(PROJECT_X, 'F:\\x', [tab(PANE_A)])]))
      yield* first.sql`INSERT INTO projects ${first.sql.insert({
        project_id: 'not-a-uuid',
        position: 1,
        directory: 'F:\\old',
        directory_key: 'f:\\old',
        display_name: 'old',
        is_git_repo: 0
      })}`
      for (const agentId of [PANE_B, PANE_C]) {
        yield* first.sql`INSERT INTO agents ${first.sql.insert({
          agent_id: agentId,
          project_id: 'not-a-uuid',
          position: 0,
          name: 'kept',
          archived: 0,
          cwd: 'F:\\old',
          model: 'claude-sonnet-5-5',
          thinking_level: 'adaptive',
          permission_mode: 'default'
        })}`
      }
      const reopened = yield* openStore(dir)
      yield* reopened.store.load
      return reopened
    })

  it.effect('lists an agent with an unknown thinking level with its project and the value', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* storeWithUnreadableTab(dir)

        const [problem, ...rest] = yield* store.unreadable

        assert.strictEqual(rest.length, 0)
        assert.strictEqual(problem._tag, 'UnreadableAgent')
        if (problem._tag !== 'UnreadableAgent') return
        assert.deepStrictEqual(
          [problem.agentId, problem.name, problem.project],
          [PANE_B, 'agent-2', 'F:\\x']
        )
        assert.include(problem.reason, '"ultra"')
      })
    )
  )

  it.effect('lists an unreadable project once, counting its agents, and none of its agents', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* storeWithUnreadableProject(dir)

        const problems = yield* store.unreadable

        assert.deepStrictEqual(
          problems.map((problem) =>
            problem._tag === 'UnreadableProject'
              ? [problem._tag, problem.projectId, problem.name, problem.agents]
              : [problem._tag]
          ),
          [['UnreadableProject', 'not-a-uuid', 'old', 2]]
        )
      })
    )
  )

  it.effect(
    'reads the directory key of every stored project, including one it could not load',
    () =>
      inTempDir((dir) =>
        Effect.gen(function* () {
          const { store } = yield* storeWithUnreadableProject(dir)

          const keys = yield* store.directoryKeys

          assert.deepStrictEqual([...keys].sort(), ['f:\\old', 'f:\\x'])
        })
      )
  )

  it.effect('fails to save another project with the directory key of one it could not load', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* storeWithUnreadableProject(dir)

        const error = yield* Effect.flip(
          store.save(workspaceOf([entry(PROJECT_X, 'F:\\old', [tab(PANE_A)])]))
        )

        assert.strictEqual(error._tag, 'WorkspaceWriteError')
      })
    )
  )

  it.effect('lists nothing when every stored row loads', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store } = yield* openStore(dir)
        yield* store.save(oneTab())

        assert.deepStrictEqual(yield* store.unreadable, [])
      })
    )
  )

  it.effect('deletes an unreadable agent with its session records', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const first = yield* openStore(dir)
        yield* first.store.save(
          workspaceOf([
            entry(PROJECT_X, 'F:\\x', [
              tab(PANE_A),
              tab(PANE_B, { sessionId: SessionId.make('s-b') })
            ])
          ])
        )
        yield* first.sql`UPDATE agents SET thinking_level = 'ultra' WHERE agent_id = ${PANE_B}`
        const { store, sql } = yield* openStore(dir)
        yield* store.load

        yield* store.deleteUnreadable({ kind: 'agent', id: PANE_B })

        assert.deepStrictEqual(
          [yield* count(sql, 'agents'), yield* count(sql, 'agent_sessions')],
          [1, 0]
        )
      })
    )
  )

  it.effect('deletes an unreadable project with its agents', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* storeWithUnreadableProject(dir)

        yield* store.deleteUnreadable({ kind: 'project', id: 'not-a-uuid' })

        assert.deepStrictEqual([yield* count(sql, 'projects'), yield* count(sql, 'agents')], [1, 1])
      })
    )
  )

  it.effect('refuses to delete an agent the loaded workspace holds', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { store, sql } = yield* storeWithUnreadableTab(dir)

        yield* store.deleteUnreadable({ kind: 'agent', id: PANE_A })

        assert.strictEqual(yield* count(sql, 'agents'), 2)
      })
    )
  )

  it.effect('names the agent holding each session id and worktree path, unreadable or not', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const worktree = { path: 'F:\\wt\\b', branch: 'dia/b', sourceRepo: 'F:\\x' }
        const first = yield* openStore(dir)
        yield* first.store.save(
          workspaceOf([
            entry(PROJECT_X, 'F:\\x', [
              tab(PANE_A, { sessionId: SessionId.make('s-a') }),
              tab(PANE_B, { config: { ...config(PANE_B, worktree.path), worktree } })
            ])
          ])
        )
        yield* first.sql`UPDATE agents SET thinking_level = 'ultra' WHERE agent_id = ${PANE_B}`
        const { store } = yield* openStore(dir)

        const holders = yield* store.holders

        assert.deepStrictEqual(
          [[...holders.sessions], [...holders.worktrees]],
          [[['s-a', 'agent-1']], [[worktree.path, 'agent-2']]]
        )
      })
    )
  )
})

describe('WorkspaceStore import of a version 2 workspace.json', () => {
  const writeFile = (dir: string, workspace: Workspace) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.writeFileString(`${dir}/workspace.json`, JSON.stringify({ version: 2, workspace }))
    )

  it.effect('loads the workspace the file held', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const workspace = workspaceOf(
          [entry(PROJECT_X, 'F:\\x', [tab(PANE_A, { sessionId: SessionId.make('s-1') })])],
          PANE_A
        )
        yield* writeFile(dir, workspace)

        const { store } = yield* openStore(dir)

        assert.deepStrictEqual(yield* store.load, Option.some(workspace))
      })
    )
  )

  it.effect('renames the file to workspace.imported.json with its contents unchanged', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* writeFile(dir, oneTab())
        const raw = yield* fs.readFileString(`${dir}/workspace.json`)

        yield* openStore(dir)

        assert.deepStrictEqual(
          [
            yield* fs.exists(`${dir}/workspace.json`),
            yield* fs.readFileString(`${dir}/workspace.imported.json`)
          ],
          [false, raw]
        )
      })
    )
  )

  it.effect('leaves a malformed file in place and starts empty', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${dir}/workspace.json`, '{"version":2,"workspace":{}}')

        const { store } = yield* openStore(dir)

        assert.deepStrictEqual(
          [Option.isNone(yield* store.load), yield* fs.exists(`${dir}/workspace.json`)],
          [true, true]
        )
      })
    )
  )

  it.effect('does not import again once a workspace is stored', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const first = yield* openStore(dir)
        yield* first.store.save(workspaceOf([]))
        yield* writeFile(dir, oneTab())

        const second = yield* openStore(dir)

        assert.deepStrictEqual(yield* second.store.load, Option.some(workspaceOf([])))
      })
    )
  )

  it.effect('imports only the first of two tabs that share a worktree path', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const worktree = { path: 'F:\\wt', branch: 'dia/w', sourceRepo: 'F:\\x' }
        yield* writeFile(
          dir,
          workspaceOf([
            entry(PROJECT_X, 'F:\\x', [
              tab(PANE_A, { config: { ...config(PANE_A, 'F:\\wt'), worktree } }),
              tab(PANE_B, { config: { ...config(PANE_B, 'F:\\wt'), worktree } })
            ])
          ])
        )

        const { store } = yield* openStore(dir)

        const loaded = Option.getOrThrow(yield* store.load)
        assert.deepStrictEqual(
          loaded.projects[0].tabs.map((loadedTab) => loadedTab.config.paneId),
          [PANE_A]
        )
      })
    )
  )

  it.effect('imports only the first of two tabs that share a session id', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const sessionId = SessionId.make('s-1')
        yield* writeFile(
          dir,
          workspaceOf([
            entry(PROJECT_X, 'F:\\x', [tab(PANE_A, { sessionId }), tab(PANE_B, { sessionId })])
          ])
        )

        const { store } = yield* openStore(dir)

        const loaded = Option.getOrThrow(yield* store.load)
        assert.deepStrictEqual(
          loaded.projects[0].tabs.map((loadedTab) => loadedTab.config.paneId),
          [PANE_A]
        )
      })
    )
  )
})

describe('WorkspaceStore import of a version 1 workspace.json', () => {
  const writeLegacy = (dir: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = path.join(dir, 'repo')
      const plain = path.join(dir, 'plain')
      const gone = path.join(dir, 'gone')
      yield* fs.makeDirectory(path.join(repo, '.git'), { recursive: true })
      yield* fs.makeDirectory(plain)
      const legacy = {
        tree: {
          _tag: 'Split',
          direction: 'row',
          sizes: [0.25, 0.25, 0.25, 0.25],
          children: [
            { _tag: 'Leaf', paneId: PANE_A, status: 'ready', cwd: plain },
            { _tag: 'Leaf', paneId: PANE_PENDING, status: 'pending' },
            {
              _tag: 'Leaf',
              paneId: PANE_B,
              status: 'ready',
              cwd: path.join(dir, 'wt'),
              sourceRepo: repo
            },
            { _tag: 'Leaf', paneId: PANE_C, status: 'ready', cwd: gone }
          ]
        },
        panes: {
          [PANE_A]: { config: config(PANE_A, plain), sessionId: 'session-a' },
          [PANE_B]: {
            config: {
              ...config(PANE_B, path.join(dir, 'wt')),
              worktree: { path: path.join(dir, 'wt'), branch: 'dia/brave-otter', sourceRepo: repo }
            }
          },
          [PANE_C]: { config: config(PANE_C, gone) }
        }
      }
      const raw = JSON.stringify(legacy)
      yield* fs.writeFileString(path.join(dir, 'workspace.json'), raw)
      return { repo, plain, gone, raw }
    })

  const importLegacy = (dir: string) =>
    Effect.gen(function* () {
      const { store } = yield* openStore(dir)
      return Option.getOrThrow(yield* store.load)
    })

  it.effect('creates one project per source directory, in the order of their first pane', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { repo, plain, gone } = yield* writeLegacy(dir)

        const workspace = yield* importLegacy(dir)

        assert.deepStrictEqual(
          workspace.projects.map((imported) => imported.project.directory),
          [plain, repo, gone]
        )
      })
    )
  )

  it.effect('keeps every configured pane as a tab with its session and drops pending panes', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeLegacy(dir)

        const workspace = yield* importLegacy(dir)
        const tabs = workspace.projects.flatMap((imported) => imported.tabs)

        assert.deepStrictEqual(
          tabs.map((imported) => [imported.config.paneId, imported.sessionId]),
          [
            [PANE_A, 'session-a'],
            [PANE_B, undefined],
            [PANE_C, undefined]
          ]
        )
      })
    )
  )

  it.effect('names a worktree tab after its dia/ branch', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeLegacy(dir)

        const workspace = yield* importLegacy(dir)

        assert.strictEqual(workspace.projects[1].tabs[0].name, 'brave-otter')
      })
    )
  )

  it.effect('detects git repos and keeps a project whose directory no longer exists', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { gone } = yield* writeLegacy(dir)

        const workspace = yield* importLegacy(dir)

        assert.deepStrictEqual(
          workspace.projects.map((imported) => imported.project.isGitRepo),
          [false, true, false]
        )
        assert.strictEqual(workspace.projects[2].project.directoryKey, yield* directoryKey(gone))
      })
    )
  )

  it.effect('shows the first migrated tab', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeLegacy(dir)

        const workspace = yield* importLegacy(dir)

        assert.deepStrictEqual(workspace.visibleTab, PANE_A)
      })
    )
  )

  it.effect('keeps the version 1 file as workspace.imported.json', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { raw } = yield* writeLegacy(dir)

        yield* importLegacy(dir)

        assert.strictEqual(yield* fs.readFileString(`${dir}/workspace.imported.json`), raw)
      })
    )
  )
})

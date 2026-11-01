import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { SessionId } from '@shared/domain/pane'
import {
  AgentName,
  EMPTY_WORKSPACE,
  type Project,
  ProjectId,
  type Tab,
  type Workspace
} from '@shared/domain/project'
import { Context, Effect, FileSystem, Layer, Option, type Path, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { makeHostDatabaseLive } from './database'
import { PaneWorkspace } from './pane-workspace'
import { makeWorkspaceProblemsLive, WorkspaceProblems } from './workspace-problems'
import { makeWorkspaceStoreLive, WorkspaceStore } from './workspace-store'

const PANE_A = '11111111-1111-4111-8111-111111111111'
const PANE_B = '22222222-2222-4222-8222-222222222222'
const PROJECT_X = ProjectId.make('55555555-5555-4555-8555-555555555555')
const SESSION = SessionId.make('9c37a1b2-0000-4000-8000-000000000001')
const WORKTREE = { path: 'F:\\wt\\a', branch: 'dia/a', sourceRepo: 'F:\\x' }

const project: Project = {
  projectId: PROJECT_X,
  directory: 'F:\\x',
  directoryKey: 'f:\\x',
  displayName: 'x',
  isGitRepo: true
}

const tab = (paneId: string, name: string, overrides: Partial<Tab> = {}): Tab => ({
  name: AgentName.make(name),
  config: {
    paneId,
    cwd: 'F:\\x',
    model: 'claude-sonnet-5-5',
    thinkingLevel: 'adaptive',
    permissionMode: 'default'
  },
  archived: false,
  ...overrides
})

const worktreeConfig = (paneId: string) => ({
  ...tab(paneId, 'unused').config,
  cwd: WORKTREE.path,
  worktree: WORKTREE
})

interface Imported {
  readonly project: Project
  readonly tab: Tab
}

const writeLegacyFile = (dir: string, tabs: ReadonlyArray<Tab>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(
      `${dir}/workspace.json`,
      JSON.stringify({ version: 2, workspace: { projects: [{ project, tabs }], visibleTab: null } })
    )
  )

const openProblems = (dir: string) =>
  Effect.gen(function* () {
    const imported: Array<Imported> = []
    const storeLayer = Layer.provideMerge(
      makeWorkspaceStoreLive(dir),
      Layer.merge(makeHostDatabaseLive(dir), NodeServices.layer)
    )
    const storeContext = yield* Layer.build(storeLayer)
    const store = Context.get(storeContext, WorkspaceStore)
    const loaded: Workspace = Option.getOrElse(yield* store.load, () => EMPTY_WORKSPACE)
    const workspace = Layer.succeed(PaneWorkspace, {
      getWorkspace: Effect.sync(() => ({
        ...loaded,
        projects: loaded.projects.map((entry) => ({
          ...entry,
          tabs: [...entry.tabs, ...imported.map((added) => added.tab)]
        }))
      })),
      importTab: (addedProject: Project, addedTab: Tab) =>
        Effect.sync(() => void imported.push({ project: addedProject, tab: addedTab }))
    } as unknown as PaneWorkspace['Service'])
    const context = yield* Layer.build(
      Layer.provide(
        makeWorkspaceProblemsLive(dir),
        Layer.mergeAll(Layer.succeedContext(storeContext), workspace)
      )
    )
    return {
      problems: Context.get(context, WorkspaceProblems),
      sql: Context.get(storeContext, SqlClient.SqlClient),
      imported
    }
  })

const inTempDir = <A, E>(
  body: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-workspace-problems-' })
    return yield* body(dir)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const sharedSessionFile = (dir: string) =>
  writeLegacyFile(dir, [
    tab(PANE_A, 'brave-otter', { sessionId: SESSION }),
    tab(PANE_B, 'calm-heron', { sessionId: SESSION })
  ])

describe('WorkspaceProblems import conflicts', () => {
  it.effect('lists a skipped tab with the session it shares and the agent holding it', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* sharedSessionFile(dir)
        const { problems } = yield* openProblems(dir)

        const listed = yield* problems.list

        assert.deepStrictEqual(listed, [
          {
            _tag: 'ImportConflict',
            agentId: PANE_B,
            name: 'calm-heron',
            project: 'x',
            session: { value: SESSION, heldBy: 'brave-otter' }
          }
        ])
      })
    )
  )

  it.effect('lists a skipped tab with the worktree it shares and the agent holding it', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeLegacyFile(dir, [
          tab(PANE_A, 'brave-otter', { config: worktreeConfig(PANE_A) }),
          tab(PANE_B, 'calm-heron', { config: worktreeConfig(PANE_B) })
        ])
        const { problems } = yield* openProblems(dir)

        const [conflict] = yield* problems.list

        assert.deepStrictEqual(
          conflict._tag === 'ImportConflict' ? [conflict.session, conflict.worktree] : [],
          [undefined, { value: WORKTREE.path, heldBy: 'brave-otter' }]
        )
      })
    )
  )

  it.effect('imports a skipped tab without the session another agent holds', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* sharedSessionFile(dir)
        const { problems, imported } = yield* openProblems(dir)

        yield* problems.resolveImportConflict(PANE_B, 'import')

        assert.deepStrictEqual(imported, [{ project, tab: tab(PANE_B, 'calm-heron') }])
      })
    )
  )

  it.effect('imports a skipped tab with its session once no agent holds it', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* sharedSessionFile(dir)
        const first = yield* openProblems(dir)
        yield* first.sql`DELETE FROM agent_sessions WHERE session_id = ${SESSION}`
        const { problems, imported } = yield* openProblems(dir)

        yield* problems.resolveImportConflict(PANE_B, 'import')

        assert.strictEqual(imported[0]?.tab.sessionId, SESSION)
      })
    )
  )

  it.effect('imports a skipped tab without the worktree another agent holds', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeLegacyFile(dir, [
          tab(PANE_A, 'brave-otter', { config: worktreeConfig(PANE_A) }),
          tab(PANE_B, 'calm-heron', { config: worktreeConfig(PANE_B) })
        ])
        const { problems, imported } = yield* openProblems(dir)

        yield* problems.resolveImportConflict(PANE_B, 'import')

        const { worktree: _worktree, ...withoutWorktree } = worktreeConfig(PANE_B)
        assert.deepStrictEqual(imported[0]?.tab.config, withoutWorktree)
      })
    )
  )

  it.effect('does not list a discarded conflict again after a restart', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* sharedSessionFile(dir)
        const first = yield* openProblems(dir)
        yield* first.problems.resolveImportConflict(PANE_B, 'discard')

        const { problems, imported } = yield* openProblems(dir)

        assert.deepStrictEqual([yield* problems.list, first.imported, imported], [[], [], []])
      })
    )
  )

  it.effect('does not list an imported conflict again after a restart, even once it is gone', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* sharedSessionFile(dir)
        const first = yield* openProblems(dir)
        yield* first.problems.resolveImportConflict(PANE_B, 'import')

        const { problems } = yield* openProblems(dir)

        assert.deepStrictEqual(yield* problems.list, [])
      })
    )
  )

  it.effect('ignores a second resolution of the same conflict', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* sharedSessionFile(dir)
        const { problems, imported } = yield* openProblems(dir)

        yield* problems.resolveImportConflict(PANE_B, 'import')
        yield* problems.resolveImportConflict(PANE_B, 'import')

        assert.strictEqual(imported.length, 1)
      })
    )
  )

  it.effect('lists no conflict when no workspace file was imported', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        const { problems } = yield* openProblems(dir)

        assert.deepStrictEqual(yield* problems.list, [])
      })
    )
  )
})

describe('WorkspaceProblems unreadable rows', () => {
  it.effect('lists an unreadable agent and no longer lists it once deleted', () =>
    inTempDir((dir) =>
      Effect.gen(function* () {
        yield* writeLegacyFile(dir, [tab(PANE_A, 'brave-otter'), tab(PANE_B, 'calm-heron')])
        const first = yield* openProblems(dir)
        yield* first.sql`UPDATE agents SET thinking_level = 'ultra' WHERE agent_id = ${PANE_B}`
        const { problems } = yield* openProblems(dir)
        const before = (yield* problems.list).map((problem) => problem._tag)

        yield* problems.deleteUnreadable({ kind: 'agent', id: PANE_B })

        assert.deepStrictEqual([before, yield* problems.list], [['UnreadableAgent'], []])
      })
    )
  )
})

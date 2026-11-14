import {
  type GitOps,
  type ProjectId,
  WorktreeCreateError,
  WorktreeIncludeError,
  WorktreeKept,
  WorktreeReattachError,
  WorktreeReleased
} from '@dia/plugin'
import type { Issue, IssueId, Objective } from '@dia-plugin/dia-issues/domain'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Option, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import {
  type IssueCwd,
  makeIssueWorkspace,
  moveIssueWorktrees,
  type WorkspaceProject
} from './issue-workspace'
import { orgMigrations } from './migrations'

const PROJECT = '00000000-0000-4000-8000-300000000001' as ProjectId
const DIRECTORY = 'F:/repos/app'

const issueOf = (n: number, title = `Fix ${n}`) =>
  ({
    id: `00000000-0000-4000-8000-60000000000${n}` as IssueId,
    paneId: `pane-${n}`,
    title
  }) as unknown as Issue

const objective = { projectId: PROJECT } as unknown as Objective

interface FakeGit {
  readonly git: GitOps
  readonly created: Array<{ readonly repo: string; readonly label: string; readonly hint: string }>
  readonly reattached: Array<string>
  readonly released: Array<string>
  readonly copied: Array<ReadonlyArray<string>>
  readonly behaviour: {
    create: 'ok' | 'fail'
    reattach: 'ok' | 'missing-branch' | 'other'
    kept: boolean
    include: Option.Option<ReadonlyArray<string>>
    includeFails: boolean
  }
}

const fakeGit = (): FakeGit => {
  const created: FakeGit['created'] = []
  const reattached: Array<string> = []
  const released: Array<string> = []
  const copied: Array<ReadonlyArray<string>> = []
  const behaviour: FakeGit['behaviour'] = {
    create: 'ok',
    reattach: 'ok',
    kept: false,
    include: Option.none(),
    includeFails: false
  }
  const git: GitOps = {
    createWorktree: (repo, owner, hint) =>
      Effect.suspend(() => {
        if (behaviour.create === 'fail') {
          return Effect.fail(
            new WorktreeCreateError({ paneId: owner.paneId, sourceRepo: repo, cause: 'boom' })
          )
        }
        created.push({ repo, label: owner.label, hint: Option.getOrElse(hint, () => '') })
        const slug = `tree-${created.length}`
        return Effect.succeed({
          path: `C:/trees/${slug}`,
          branch: `dia/${slug}`,
          sourceRepo: repo
        })
      }),
    reattachWorktree: (info, paneId) =>
      Effect.suspend(() => {
        reattached.push(info.path)
        if (behaviour.reattach === 'ok') return Effect.succeed(info)
        return Effect.fail(
          new WorktreeReattachError({
            paneId,
            path: info.path,
            cause:
              behaviour.reattach === 'missing-branch'
                ? `Branch ${info.branch} no longer exists`
                : 'git failed'
          })
        )
      }),
    releaseWorktree: (info) =>
      Effect.sync(() => {
        released.push(info.path)
        return behaviour.kept ? WorktreeKept.make({ changedFiles: 2 }) : WorktreeReleased.make({})
      }),
    findIncludedFiles: (repo, paneId) =>
      behaviour.includeFails
        ? Effect.fail(new WorktreeIncludeError({ paneId, sourceRepo: repo, cause: 'boom' }))
        : Effect.succeed(behaviour.include),
    copyIncludedFiles: (_info, files) =>
      Effect.sync(() => {
        copied.push(files)
        return []
      })
  }
  return { git, created, reattached, released, copied, behaviour }
}

const setUp = Effect.gen(function* () {
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(scope))
  const fake = fakeGit()
  const state = {
    project: Option.some<WorkspaceProject>({ directory: DIRECTORY, isGitRepo: true }),
    git: Option.some(fake.git)
  }
  const workspace = yield* makeIssueWorkspace({
    projectOf: () => Effect.sync(() => state.project),
    gitOps: Effect.sync(() => state.git)
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  const rows = () =>
    sql<{
      readonly issue_id: string
      readonly path: string
      readonly released: number
    }>`SELECT issue_id, path, released FROM issue_worktrees ORDER BY rowid`
  return { sql, fake, state, workspace, rows }
})

const pathOf = (cwd: IssueCwd) => (cwd._tag === 'IssueDirectory' ? cwd.path : cwd._tag)

describe('IssueWorkspace.open', () => {
  it.effect('creates a worktree named after the issue and stores it when the switch is on', () =>
    Effect.gen(function* () {
      const { fake, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      const issue = issueOf(1, 'Fix login')

      const cwd = yield* workspace.open(issue, objective)

      assert.deepStrictEqual(
        [cwd, fake.created, yield* rows()],
        [
          { _tag: 'IssueDirectory', path: 'C:/trees/tree-1', projectDirectory: DIRECTORY },
          [{ repo: DIRECTORY, label: 'Issue · Fix login', hint: 'Fix login 00000000' }],
          [{ issue_id: issue.id, path: 'C:/trees/tree-1', released: 0 }]
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('copies the included files into the new worktree', () =>
    Effect.gen(function* () {
      const { fake, workspace } = yield* setUp
      fake.behaviour.include = Option.some(['.env'])
      yield* workspace.setWorktreeProjects(PROJECT, true)

      yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual(fake.copied, [['.env']])
    }).pipe(Effect.scoped)
  )

  it.effect('still returns the worktree and keeps its row when the include lookup fails', () =>
    Effect.gen(function* () {
      const { fake, workspace, rows } = yield* setUp
      fake.behaviour.includeFails = true
      yield* workspace.setWorktreeProjects(PROJECT, true)

      const cwd = yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual([pathOf(cwd), (yield* rows()).length], ['C:/trees/tree-1', 1])
    }).pipe(Effect.scoped)
  )

  it.effect('runs in the project directory with no worktree when the switch is off', () =>
    Effect.gen(function* () {
      const { fake, workspace } = yield* setUp

      const cwd = yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual([pathOf(cwd), fake.created.length], [DIRECTORY, 0])
    }).pipe(Effect.scoped)
  )

  it.effect('runs in the project directory when the project is not a git repository', () =>
    Effect.gen(function* () {
      const { fake, state, workspace } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      state.project = Option.some({ directory: DIRECTORY, isGitRepo: false })

      const cwd = yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual([pathOf(cwd), fake.created.length], [DIRECTORY, 0])
    }).pipe(Effect.scoped)
  )

  it.effect('gives two issues of one project different directories', () =>
    Effect.gen(function* () {
      const { workspace } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)

      const first = yield* workspace.open(issueOf(1), objective)
      const second = yield* workspace.open(issueOf(2), objective)

      assert.notStrictEqual(pathOf(first), pathOf(second))
    }).pipe(Effect.scoped)
  )

  it.effect('reattaches the stored worktree on a later open, in the same path', () =>
    Effect.gen(function* () {
      const { fake, workspace } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      const first = yield* workspace.open(issueOf(1), objective)

      const second = yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual(
        [pathOf(second), fake.created.length, fake.reattached],
        [pathOf(first), 1, [pathOf(first)]]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('waits while no worktrees plugin is provided and stores nothing', () =>
    Effect.gen(function* () {
      const { state, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      state.git = Option.none()

      const cwd = yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual([cwd._tag, (yield* rows()).length], ['IssueWaiting', 0])
    }).pipe(Effect.scoped)
  )

  it.effect('waits when the worktree cannot be created', () =>
    Effect.gen(function* () {
      const { fake, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      fake.behaviour.create = 'fail'

      const cwd = yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual([cwd._tag, (yield* rows()).length], ['IssueWaiting', 0])
    }).pipe(Effect.scoped)
  )

  it.effect('waits, keeping its row, when reattaching fails for another reason', () =>
    Effect.gen(function* () {
      const { fake, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      yield* workspace.open(issueOf(1), objective)
      fake.behaviour.reattach = 'other'

      const cwd = yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual([cwd._tag, (yield* rows()).length], ['IssueWaiting', 1])
    }).pipe(Effect.scoped)
  )

  it.effect('creates a fresh worktree when the stored branch no longer exists', () =>
    Effect.gen(function* () {
      const { fake, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      yield* workspace.open(issueOf(1), objective)
      fake.behaviour.reattach = 'missing-branch'

      const cwd = yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual(
        [pathOf(cwd), (yield* rows()).map((row) => row.path)],
        ['C:/trees/tree-2', ['C:/trees/tree-2']]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('waits while its project is absent from the workspace, and keeps the switch', () =>
    Effect.gen(function* () {
      const { state, workspace } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      state.project = Option.none()

      const absent = yield* workspace.open(issueOf(1), objective)
      state.project = Option.some({ directory: DIRECTORY, isGitRepo: true })
      const back = yield* workspace.open(issueOf(1), objective)

      assert.deepStrictEqual(
        [absent._tag, pathOf(back), yield* workspace.worktreeProjects],
        ['IssueWaiting', 'C:/trees/tree-1', [PROJECT]]
      )
    }).pipe(Effect.scoped)
  )
})

describe('IssueWorkspace.retain', () => {
  it.effect('releases the worktree of an issue that left the set, once', () =>
    Effect.gen(function* () {
      const { fake, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      const kept = issueOf(1)
      const left = issueOf(2)
      yield* workspace.open(kept, objective)
      yield* workspace.open(left, objective)

      yield* workspace.retain(new Set([kept.id]))
      yield* workspace.retain(new Set([kept.id]))

      assert.deepStrictEqual(
        [fake.released, (yield* rows()).map((row) => row.released)],
        [['C:/trees/tree-2'], [0, 1]]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('marks a worktree released when it is kept for the user, not retried', () =>
    Effect.gen(function* () {
      const { fake, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      yield* workspace.open(issueOf(1), objective)
      fake.behaviour.kept = true

      yield* workspace.retain(new Set())
      yield* workspace.retain(new Set())

      assert.deepStrictEqual([fake.released.length, (yield* rows())[0]?.released], [1, 1])
    }).pipe(Effect.scoped)
  )

  it.effect('leaves the row unreleased while no plugin is provided, and retries later', () =>
    Effect.gen(function* () {
      const { fake, state, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      yield* workspace.open(issueOf(1), objective)
      const git = state.git
      state.git = Option.none()

      yield* workspace.retain(new Set())
      const waiting = (yield* rows())[0]?.released
      state.git = git
      yield* workspace.retain(new Set())

      assert.deepStrictEqual(
        [waiting, (yield* rows())[0]?.released, fake.released.length],
        [0, 1, 1]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('reattaches a released worktree on open and marks it unreleased', () =>
    Effect.gen(function* () {
      const { fake, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      const issue = issueOf(1)
      const first = yield* workspace.open(issue, objective)
      yield* workspace.retain(new Set())

      const again = yield* workspace.open(issue, objective)

      assert.deepStrictEqual(
        [pathOf(again), fake.created.length, (yield* rows())[0]?.released],
        [pathOf(first), 1, 0]
      )
    }).pipe(Effect.scoped)
  )
})

describe('IssueWorkspace.setWorktreeProjects', () => {
  it.effect('adds and removes a project, and adding twice keeps one entry', () =>
    Effect.gen(function* () {
      const { workspace } = yield* setUp

      yield* workspace.setWorktreeProjects(PROJECT, true)
      yield* workspace.setWorktreeProjects(PROJECT, true)
      const on = yield* workspace.worktreeProjects
      yield* workspace.setWorktreeProjects(PROJECT, false)

      assert.deepStrictEqual([on, yield* workspace.worktreeProjects], [[PROJECT], []])
    }).pipe(Effect.scoped)
  )
})

describe('moveIssueWorktrees', () => {
  it.effect('rewrites a stored worktree path under the moved folder and leaves others', () =>
    Effect.gen(function* () {
      const { sql, workspace, rows } = yield* setUp
      yield* workspace.setWorktreeProjects(PROJECT, true)
      yield* workspace.open(issueOf(1), objective)
      yield* sql`INSERT INTO issue_worktrees (issue_id, path, branch, source_repo)
        VALUES ('other', 'D:/elsewhere/tree', 'dia/x', ${DIRECTORY})`

      yield* moveIssueWorktrees({ from: 'C:/trees', to: 'C:/dia-trees' }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )

      assert.deepStrictEqual(
        (yield* rows()).map((row) => row.path),
        ['C:/dia-trees/tree-1', 'D:/elsewhere/tree']
      )
    }).pipe(Effect.scoped)
  )
})

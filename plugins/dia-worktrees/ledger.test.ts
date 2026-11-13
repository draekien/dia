import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import type { ReleaseOutcome, WorktreeInfo } from '@shared/domain/pane'
import { WorktreeKept, WorktreeReleased } from '@shared/domain/pane'
import { Duration, Effect, FileSystem, Layer, Option, Path, Result, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { makePluginDatabase } from '../../src/host/services/database'
import { Active, Kept, LedgerStateChanged, NeedsDecision, Removed } from './calls'
import type { GitCommands } from './git-ops'
import { recordingGitOps } from './host'
import { type Ledger, makeLedger, worktreeMigrations } from './ledger'

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const PANE = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER = { paneId: PANE, label: 'Tab · repo' }
const info = (name: string): WorktreeInfo => ({
  path: `/trees/${name}`,
  branch: `dia/${name}`,
  sourceRepo: '/repo'
})
const A = info('a')

const open = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filename = path.join(yield* fs.makeTempDirectoryScoped(), 'worktrees.db')
  const sql = yield* makePluginDatabase(filename, 'worktrees')(worktreeMigrations)
  return { sql, ledger: yield* makeLedger(sql) }
})

const rows = (ledger: Ledger) =>
  ledger.changes.pipe(
    Stream.runHead,
    Effect.map((head) => Option.getOrThrow(head))
  )

const stateOf = (ledger: Ledger, path: string) =>
  rows(ledger).pipe(Effect.map((list) => list.find((entry) => entry.info.path === path)?.state))

const neverRelease: Effect.Effect<ReleaseOutcome> = Effect.die('release must not run')

describe('worktree ledger', () => {
  it.effect('records a created worktree as Active under its owner label', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open

      yield* ledger.recordCreated(A, OWNER)

      assert.deepStrictEqual(
        (yield* rows(ledger)).map(({ info, owner, state }) => ({ info, owner, state })),
        [{ info: A, owner: OWNER, state: Active.make({}) }]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('marks a released worktree Removed', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)

      const outcome = yield* ledger.release(A, PANE, Effect.succeed(WorktreeReleased.make({})))

      assert.deepStrictEqual(
        [outcome, yield* stateOf(ledger, A.path)],
        [WorktreeReleased.make({}), Removed.make({})]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('marks a kept worktree NeedsDecision with its changed files', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)

      const outcome = yield* ledger.release(
        A,
        PANE,
        Effect.succeed(WorktreeKept.make({ changedFiles: 3 }))
      )

      assert.deepStrictEqual(
        [outcome, yield* stateOf(ledger, A.path)],
        [WorktreeKept.make({ changedFiles: 3 }), NeedsDecision.make({ changedFiles: 3 })]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('returns the recorded outcome of a Removed worktree without releasing again', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)
      yield* ledger.release(A, PANE, Effect.succeed(WorktreeReleased.make({})))
      const before = (yield* rows(ledger))[0]

      const outcome = yield* ledger.release(A, PANE, neverRelease)

      assert.deepStrictEqual(
        [outcome, (yield* rows(ledger))[0]],
        [WorktreeReleased.make({}), before]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('returns WorktreeKept with the stored count for a NeedsDecision worktree', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)
      yield* ledger.release(A, PANE, Effect.succeed(WorktreeKept.make({ changedFiles: 2 })))

      const outcome = yield* ledger.release(A, PANE, neverRelease)

      assert.deepStrictEqual(outcome, WorktreeKept.make({ changedFiles: 2 }))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('leaves a Kept worktree Kept when it is released again', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)
      yield* ledger.release(A, PANE, Effect.succeed(WorktreeKept.make({ changedFiles: 2 })))
      yield* ledger.keep(A.path)

      const outcome = yield* ledger.release(A, PANE, neverRelease)

      assert.deepStrictEqual(
        [outcome, yield* stateOf(ledger, A.path)],
        [WorktreeKept.make({ changedFiles: 2 }), Kept.make({ changedFiles: 2 })]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('adopts a reattached worktree with no row under the label Pane <paneId>', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open

      yield* ledger.recordReattached(A, PANE)

      assert.deepStrictEqual(
        (yield* rows(ledger)).map(({ owner, state }) => ({ owner, state })),
        [{ owner: { paneId: PANE, label: `Pane ${PANE}` }, state: Active.make({}) }]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('sets a Kept worktree Active on reattach and keeps its label', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)
      yield* ledger.release(A, PANE, Effect.succeed(WorktreeKept.make({ changedFiles: 1 })))
      yield* ledger.keep(A.path)

      yield* ledger.recordReattached(A, PANE)

      const [entry] = yield* rows(ledger)
      assert.deepStrictEqual([entry.state, entry.owner.label], [Active.make({}), 'Tab · repo'])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('discards a NeedsDecision worktree by force-removing it and marking it Removed', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)
      yield* ledger.release(A, PANE, Effect.succeed(WorktreeKept.make({ changedFiles: 1 })))
      const forced: Array<string> = []

      yield* ledger.discard(A.path, (target) => Effect.sync(() => void forced.push(target.path)))

      assert.deepStrictEqual([forced, yield* stateOf(ledger, A.path)], [[A.path], Removed.make({})])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('refuses to discard an Active worktree with LedgerStateChanged', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)

      const result = yield* Effect.result(ledger.discard(A.path, () => Effect.die('must not run')))

      assert.deepStrictEqual(
        result,
        Result.fail(new LedgerStateChanged({ path: A.path, state: Active.make({}) }))
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('refuses to keep a Kept worktree with LedgerStateChanged', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)
      yield* ledger.release(A, PANE, Effect.succeed(WorktreeKept.make({ changedFiles: 1 })))
      yield* ledger.keep(A.path)

      const result = yield* Effect.result(ledger.keep(A.path))

      assert.deepStrictEqual(
        result,
        Result.fail(new LedgerStateChanged({ path: A.path, state: Kept.make({ changedFiles: 1 }) }))
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('refuses to discard a worktree the ledger does not know, reporting Removed', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open

      const result = yield* Effect.result(ledger.discard('/trees/none', () => Effect.void))

      assert.deepStrictEqual(
        result,
        Result.fail(new LedgerStateChanged({ path: '/trees/none', state: Removed.make({}) }))
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('rejects a Kept row with no changed-file count', () =>
    Effect.gen(function* () {
      const { sql } = yield* open

      const result = yield* Effect.result(
        sql`INSERT INTO worktrees (path, branch, source_repo, pane_id, label, state, changed_files, updated_at)
            VALUES ('/p', 'b', '/r', 'p', 'l', 'Kept', NULL, 0)`
      )

      assert.isTrue(Result.isFailure(result))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('rejects an unknown state', () =>
    Effect.gen(function* () {
      const { sql } = yield* open

      const result = yield* Effect.result(
        sql`INSERT INTO worktrees (path, branch, source_repo, pane_id, label, state, changed_files, updated_at)
            VALUES ('/p', 'b', '/r', 'p', 'l', 'Lost', NULL, 0)`
      )

      assert.isTrue(Result.isFailure(result))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('deletes Removed rows older than seven days at start and keeps the rest', () =>
    Effect.gen(function* () {
      const { sql, ledger } = yield* open
      const B = info('b')
      const C = info('c')
      yield* ledger.recordCreated(A, OWNER)
      yield* ledger.release(A, PANE, Effect.succeed(WorktreeReleased.make({})))
      yield* ledger.recordCreated(C, OWNER)
      yield* TestClock.adjust(Duration.days(3))
      yield* ledger.recordCreated(B, OWNER)
      yield* ledger.release(B, PANE, Effect.succeed(WorktreeReleased.make({})))
      yield* TestClock.adjust(Duration.days(5))

      const restarted = yield* makeLedger(sql)

      assert.deepStrictEqual((yield* rows(restarted)).map((entry) => entry.info.path).sort(), [
        B.path,
        C.path
      ])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('keeps a Removed row exactly seven days old', () =>
    Effect.gen(function* () {
      const { sql, ledger } = yield* open
      yield* ledger.recordCreated(A, OWNER)
      yield* ledger.release(A, PANE, Effect.succeed(WorktreeReleased.make({})))
      yield* TestClock.adjust(Duration.days(7))

      const restarted = yield* makeLedger(sql)

      assert.strictEqual((yield* rows(restarted)).length, 1)
    }).pipe(Effect.scoped, Effect.provide(platform))
  )
})

describe('recordingGitOps', () => {
  const fakeGit = (outcome: ReleaseOutcome): GitCommands => ({
    createWorktree: (sourceRepo) =>
      Effect.succeed({ path: '/trees/new', branch: 'dia/new', sourceRepo }),
    reattachWorktree: (worktree) => Effect.succeed(worktree),
    releaseWorktree: () => Effect.succeed(outcome),
    forceRemoveWorktree: () => Effect.void,
    findIncludedFiles: () => Effect.succeed(Option.none()),
    copyIncludedFiles: () => Effect.succeed([])
  })

  it.effect('records create, reattach and release in the ledger', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      const ops = recordingGitOps(fakeGit(WorktreeKept.make({ changedFiles: 4 })), ledger)

      const created = yield* ops.createWorktree('/repo', OWNER, Option.none())
      const afterCreate = yield* stateOf(ledger, created.path)
      yield* ops.releaseWorktree(created, PANE)
      const afterRelease = yield* stateOf(ledger, created.path)
      yield* ops.reattachWorktree(created, PANE)

      assert.deepStrictEqual(
        [afterCreate, afterRelease, yield* stateOf(ledger, created.path)],
        [Active.make({}), NeedsDecision.make({ changedFiles: 4 }), Active.make({})]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('moves the paths of rows under a moved folder and returns the live ones', () =>
    Effect.gen(function* () {
      const { ledger } = yield* open
      const B = info('b')
      yield* ledger.recordCreated(A, OWNER)
      yield* ledger.recordCreated(B, OWNER)
      yield* ledger.release(B, PANE, Effect.succeed(WorktreeReleased.make({})))
      yield* ledger.recordCreated({ ...info('c'), path: '/elsewhere/c' }, OWNER)

      const moved = yield* ledger.movePaths({ from: '/trees', to: '/dia-trees' })

      assert.deepStrictEqual(moved, [{ ...A, path: '/dia-trees/a' }])
      assert.deepStrictEqual((yield* rows(ledger)).map((entry) => entry.info.path).sort(), [
        '/dia-trees/a',
        '/dia-trees/b',
        '/elsewhere/c'
      ])
    }).pipe(Effect.scoped, Effect.provide(platform))
  )
})

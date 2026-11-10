import {
  type PaneId,
  type PluginMigrations,
  type ReleaseOutcome,
  type WorktreeInfo,
  WorktreeKept,
  type WorktreeOwner,
  WorktreeReleased
} from '@dia/plugin'
import { Clock, Duration, Effect, Schema, Semaphore, type Stream, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  Active,
  Kept,
  type LedgerEntry,
  type LedgerState,
  LedgerStateChanged,
  NeedsDecision,
  Removed
} from './calls'

/** The `worktrees` plugin's database migrations; pass them to `ctx.database`. */
export const worktreeMigrations: PluginMigrations = {
  '1_create_worktrees': Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE worktrees (
      path          TEXT PRIMARY KEY,
      branch        TEXT NOT NULL,
      source_repo   TEXT NOT NULL,
      pane_id       TEXT NOT NULL,
      label         TEXT NOT NULL,
      state         TEXT NOT NULL CHECK (state IN ('Active', 'NeedsDecision', 'Kept', 'Removed')),
      changed_files INTEGER,
      updated_at    INTEGER NOT NULL,
      CHECK ((state IN ('NeedsDecision', 'Kept')) = (changed_files IS NOT NULL))
    )`)
  })
}

const REMOVED_RETENTION = Duration.days(7)

const Row = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  source_repo: Schema.String,
  pane_id: Schema.String,
  label: Schema.String,
  state: Schema.Literals(['Active', 'NeedsDecision', 'Kept', 'Removed']),
  changed_files: Schema.NullOr(Schema.Int),
  updated_at: Schema.Number
})
type Row = typeof Row.Type
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))

const stateOf = (row: Row): LedgerState => {
  switch (row.state) {
    case 'Active':
      return Active.make({})
    case 'Removed':
      return Removed.make({})
    case 'NeedsDecision':
      return NeedsDecision.make({ changedFiles: row.changed_files ?? 0 })
    case 'Kept':
      return Kept.make({ changedFiles: row.changed_files ?? 0 })
  }
}

const entryOf = (row: Row): LedgerEntry => ({
  info: { path: row.path, branch: row.branch, sourceRepo: row.source_repo },
  owner: { paneId: row.pane_id, label: row.label },
  state: stateOf(row),
  updatedAt: row.updated_at
})

const changedFilesOf = (state: LedgerState): number | null =>
  state._tag === 'NeedsDecision' || state._tag === 'Kept' ? state.changedFiles : null

const outcomeOf = (state: LedgerState): ReleaseOutcome =>
  state._tag === 'NeedsDecision' || state._tag === 'Kept'
    ? WorktreeKept.make({ changedFiles: state.changedFiles })
    : WorktreeReleased.make({})

/**
 * The ledger of every worktree dia created, and the only writer of the `worktrees` table. Every
 * method that writes one worktree's row runs under that worktree's lock, so a pane's reattach and
 * the user's Discard cannot interleave.
 */
export interface Ledger {
  /** Records a worktree just created for `owner` as `Active`. */
  readonly recordCreated: (info: WorktreeInfo, owner: WorktreeOwner) => Effect.Effect<void>
  /**
   * Sets the worktree `Active`, whatever state it was in. A worktree with no row is adopted under
   * the label `Pane <paneId>`.
   */
  readonly recordReattached: (info: WorktreeInfo, paneId: PaneId) => Effect.Effect<void>
  /**
   * Runs `release` and records its outcome (`Removed` for released, `NeedsDecision` for kept) when
   * the worktree is `Active` or has no row. For any other state it returns the recorded outcome
   * without running `release` or writing, so releasing twice is safe and `Kept` never returns to
   * `NeedsDecision`.
   */
  readonly release: (
    info: WorktreeInfo,
    paneId: PaneId,
    release: Effect.Effect<ReleaseOutcome>
  ) => Effect.Effect<ReleaseOutcome>
  /**
   * Runs `forceRemove` on a `NeedsDecision` or `Kept` worktree and marks it `Removed`. Fails with
   * {@link LedgerStateChanged} when the row is in any other state or absent.
   */
  readonly discard: (
    path: string,
    forceRemove: (info: WorktreeInfo, paneId: PaneId) => Effect.Effect<void>
  ) => Effect.Effect<void, LedgerStateChanged>
  /**
   * Marks a `NeedsDecision` worktree `Kept`. Fails with {@link LedgerStateChanged} when the row is
   * in any other state or absent.
   */
  readonly keep: (path: string) => Effect.Effect<void, LedgerStateChanged>
  /** Every row: the current list, then the list after each change. */
  readonly changes: Stream.Stream<ReadonlyArray<LedgerEntry>>
}

/**
 * Builds the {@link Ledger} over `sql`, which has {@link worktreeMigrations} applied. Deletes
 * `Removed` rows older than seven days (by `Clock`) once, now. Run it once in the plugin's setup.
 */
export const makeLedger = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const locks = new Map<string, Semaphore.Semaphore>()
    const withLock = <A, E>(path: string, effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        const existing = locks.get(path)
        const lock = existing ?? Semaphore.makeUnsafe(1)
        if (existing === undefined) locks.set(path, lock)
        return lock.withPermit(effect)
      })

    const selectAll = sql`SELECT * FROM worktrees ORDER BY updated_at DESC, path`.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows.map(entryOf)),
      Effect.orDie
    )

    const now = yield* Clock.currentTimeMillis
    const cutoff = now - Duration.toMillis(REMOVED_RETENTION)
    yield* sql`DELETE FROM worktrees WHERE state = 'Removed' AND updated_at < ${cutoff}`.pipe(
      Effect.orDie
    )
    const entries = yield* SubscriptionRef.make(yield* selectAll)

    const find = (path: string) =>
      sql`SELECT * FROM worktrees WHERE path = ${path}`.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((rows) => rows[0]),
        Effect.orDie
      )

    const write = Effect.fnUntraced(function* (
      info: WorktreeInfo,
      owner: WorktreeOwner,
      state: LedgerState
    ) {
      const updatedAt = yield* Clock.currentTimeMillis
      yield* sql`INSERT OR REPLACE INTO worktrees ${sql.insert({
        path: info.path,
        branch: info.branch,
        source_repo: info.sourceRepo,
        pane_id: owner.paneId,
        label: owner.label,
        state: state._tag,
        changed_files: changedFilesOf(state),
        updated_at: updatedAt
      })}`.pipe(Effect.orDie)
      yield* SubscriptionRef.set(entries, yield* selectAll)
      yield* Effect.logInfo('Worktree ledger updated', { path: info.path, state: state._tag })
    })

    const infoOf = (row: Row): WorktreeInfo => entryOf(row).info
    const ownerOf = (row: Row): WorktreeOwner => entryOf(row).owner
    const ownerOrAdopted = (row: Row | undefined, paneId: PaneId): WorktreeOwner =>
      row === undefined ? { paneId, label: `Pane ${paneId}` } : ownerOf(row)

    const recordCreated: Ledger['recordCreated'] = (info, owner) =>
      withLock(info.path, write(info, owner, Active.make({})))

    const recordReattached: Ledger['recordReattached'] = (info, paneId) =>
      withLock(
        info.path,
        Effect.gen(function* () {
          const row = yield* find(info.path)
          if (row === undefined) {
            yield* Effect.logInfo('Adopting a worktree with no ledger row', {
              path: info.path,
              paneId
            })
          }
          yield* write(info, ownerOrAdopted(row, paneId), Active.make({}))
        })
      )

    const release: Ledger['release'] = (info, paneId, doRelease) =>
      withLock(
        info.path,
        Effect.gen(function* () {
          const row = yield* find(info.path)
          if (row !== undefined && row.state !== 'Active') {
            yield* Effect.logInfo('Release skipped: the worktree is not active', {
              path: info.path,
              state: row.state
            })
            return outcomeOf(stateOf(row))
          }
          const outcome = yield* doRelease
          const owner = ownerOrAdopted(row, paneId)
          if (outcome._tag === 'WorktreeKept') {
            yield* write(info, owner, NeedsDecision.make({ changedFiles: outcome.changedFiles }))
          } else if (row !== undefined) {
            yield* write(info, owner, Removed.make({}))
          }
          return outcome
        })
      )

    const changeState = Effect.fnUntraced(function* (
      path: string,
      accepts: ReadonlyArray<LedgerState['_tag']>,
      apply: (row: Row) => Effect.Effect<LedgerState>
    ) {
      const row = yield* find(path)
      if (row === undefined || !accepts.includes(row.state)) {
        return yield* new LedgerStateChanged({
          path,
          state: row === undefined ? Removed.make({}) : stateOf(row)
        })
      }
      const next = yield* apply(row)
      yield* write(infoOf(row), ownerOf(row), next)
    })

    const discard: Ledger['discard'] = (path, forceRemove) =>
      withLock(
        path,
        changeState(path, ['NeedsDecision', 'Kept'], (row) =>
          forceRemove(infoOf(row), row.pane_id).pipe(Effect.as(Removed.make({})))
        )
      )

    const keep: Ledger['keep'] = (path) =>
      withLock(
        path,
        changeState(path, ['NeedsDecision'], (row) =>
          Effect.succeed(Kept.make({ changedFiles: row.changed_files ?? 0 }))
        )
      )

    const ledger: Ledger = {
      recordCreated,
      recordReattached,
      release,
      discard,
      keep,
      changes: SubscriptionRef.changes(entries)
    }
    return ledger
  })

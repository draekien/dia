import type {
  CommittedEvent,
  Git,
  GitError,
  GitOps,
  PluginControl,
  RunEvents,
  StoredEvent
} from '@dia/plugin'
import { WorktreeInfo } from '@dia/plugin'
import { boundaryOf } from '@dia-plugin/dia-checkpoints/boundaries'
import { Data, Effect, Option, PubSub, Ref, Schema, type Scope, Semaphore, Stream } from 'effect'
import type { SqlClient, SqlError } from 'effect/sql'
import {
  type CreatorThreadState,
  MergeFailed,
  PluginLoad,
  RevertFailed,
  type TurnChange,
  TurnCommit
} from './calls'
import { joinInside, overridesInside, pluginsTouched, reloadPlugins } from './plugin-folders'

const AUTHOR = { name: 'dia', email: 'dia@localhost' }

const PLUGIN_TOOLS = new Set([
  'mcp__dia__plugin_override',
  'mcp__dia__plugin_reload',
  'mcp__dia__plugin_clear_override'
])

const FOLDED_TAGS = ['PaneUserMessagesSent', 'PaneAttentionChanged', 'ToolCallCompleted'] as const

const EMPTY_STATE: CreatorThreadState = { turns: [], unmerged: 0, lastMerge: null }

const Strings = Schema.Array(Schema.String)

const TurnRow = Schema.Struct({
  turn_id: Schema.String,
  message_ids: Schema.fromJsonString(Strings),
  from_sha: Schema.String,
  to_sha: Schema.NullOr(Schema.String),
  commits: Schema.fromJsonString(Schema.Array(TurnCommit)),
  plugins: Schema.fromJsonString(Strings),
  loads: Schema.fromJsonString(Schema.Array(PluginLoad)),
  revert_sha: Schema.NullOr(Schema.String)
})
type TurnRow = typeof TurnRow.Type

const RunRow = Schema.Struct({
  run_id: Schema.String,
  last_sequence: Schema.Number,
  worktree: Schema.fromJsonString(WorktreeInfo),
  last_merge_sha: Schema.NullOr(Schema.String)
})

const decodeTurnRows = Schema.decodeUnknownEffect(Schema.Array(TurnRow))
const encodeStrings = Schema.encodeSync(TurnRow.fields.message_ids)
const encodeCommits = Schema.encodeSync(TurnRow.fields.commits)
const encodeLoads = Schema.encodeSync(TurnRow.fields.loads)
const encodeWorktree = Schema.encodeSync(Schema.fromJsonString(WorktreeInfo))

type Write = Effect.Effect<void, SqlError.SqlError>

const NO_WRITE: Write = Effect.void
const decodeRunRows = Schema.decodeUnknownEffect(Schema.Array(RunRow))

class BranchMissing extends Data.TaggedError('BranchMissing')<{ readonly branch: string }> {}

interface TrackedRun {
  readonly worktree: WorktreeInfo
  readonly lastSequence: number
}

/**
 * What the turn changes read and drive: the plugin database, git, the run event log, the plugins
 * the Host knows, `reattach` to re-add a run's worktree, and `metaDirectory`, the meta repo's
 * working tree.
 */
export interface TurnChangesDeps {
  readonly sql: SqlClient.SqlClient
  readonly git: Pick<Git, 'resolveCommit' | 'log' | 'revert' | 'merge' | 'changedFiles'>
  readonly runEvents: Pick<RunEvents, 'readTagged'>
  readonly plugins: PluginControl
  readonly reattach: GitOps['reattachWorktree']
  readonly metaDirectory: string
}

/** A Creator run whose branch has commits the meta repo's branch lacks, and its worktree. */
export interface UnmergedRun {
  readonly runId: string
  readonly worktree: WorktreeInfo
}

/** What each Creator turn changed, and the revert and merge of a Creator thread's branch. */
export interface TurnChanges {
  /**
   * Records Creator run `runId`, working in `worktree`, so the events after `lastSequence` are
   * folded into its turns. Call it before the run's first message is sent.
   */
  readonly track: (
    runId: string,
    worktree: WorktreeInfo,
    lastSequence: number
  ) => Effect.Effect<void>
  /** Folds the stored events of every tracked run that were committed while nothing folded them. */
  readonly catchUp: Effect.Effect<void>
  /** Folds `committed` into its run's turns; an event of an untracked run, or one already folded, does nothing. */
  readonly fold: (committed: CommittedEvent) => Effect.Effect<void>
  /** Creator run `runId`'s state; an untracked run has no turns and nothing to merge. */
  readonly state: (runId: string) => Effect.Effect<CreatorThreadState>
  /** `state(runId)` now and after each change of run `runId`. */
  readonly follow: (runId: string) => Stream.Stream<CreatorThreadState>
  /** The tracked runs whose branch has commits the meta repo's branch lacks. */
  readonly unmerged: Effect.Effect<ReadonlyArray<UnmergedRun>>
  /**
   * Reverts the commits of ended turn `turnId` of run `runId` with one commit on the run's branch,
   * reloads the plugins loaded from the run's worktree whose folders those commits changed, and
   * returns the turn. A turn already reverted is returned as it is.
   */
  readonly revert: (runId: string, turnId: string) => Effect.Effect<TurnChange, RevertFailed>
  /**
   * Merges run `runId`'s branch into the meta repo's current branch with a merge commit, points each
   * plugin overridden into the run's worktree at the same folder in the meta repo, reloads those
   * plugins and the meta repo plugins the merge changed, and returns the merge commit.
   */
  readonly merge: (runId: string) => Effect.Effect<{ readonly sha: string }, MergeFailed>
}

const toChange = (row: TurnRow): TurnChange => ({
  turnId: row.turn_id,
  messageIds: row.message_ids,
  ended: row.to_sha !== null,
  commits: row.commits,
  loads: row.loads,
  revert: row.revert_sha === null ? null : { sha: row.revert_sha }
})

const parseCommits = (output: string): ReadonlyArray<TurnCommit> =>
  output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [sha = '', subject = ''] = line.split('\x1f')
      return { sha: sha.trim(), subject }
    })

const failLogged = <E extends { readonly reason: string; readonly message: string }>(
  log: string,
  error: E
) =>
  Effect.andThen(
    Effect.logWarning(log, { reason: error.reason, message: error.message }),
    Effect.fail(error)
  )

const gitReason = (error: GitError) => error.stderr.trim() || error.message

const revertMessage = (commits: ReadonlyArray<TurnCommit>) =>
  commits.length === 1
    ? `Revert "${commits[0]?.subject ?? ''}"`
    : `Revert ${commits.length} commits`

/**
 * Builds the turn changes over `deps` inside the calling scope, tracking the Creator runs the
 * database holds. Call `catchUp`, then `fold` every event from a run event subscription opened
 * before `catchUp`.
 */
export const makeTurnChanges = Effect.fn('makeTurnChanges')(function* (
  deps: TurnChangesDeps
): Effect.fn.Return<TurnChanges, never, Scope.Scope> {
  const { sql, git, plugins, metaDirectory } = deps
  const lock = yield* Semaphore.make(1)
  const changed = yield* Effect.acquireRelease(PubSub.unbounded<string>(), PubSub.shutdown)
  const stored =
    yield* sql`SELECT run_id, last_sequence, worktree, last_merge_sha FROM creator_runs`.pipe(
      Effect.flatMap(decodeRunRows),
      Effect.orDie
    )
  const tracked = yield* Ref.make(
    new Map<string, TrackedRun>(
      stored.map((row) => [row.run_id, { worktree: row.worktree, lastSequence: row.last_sequence }])
    )
  )

  const trackedRun = (runId: string) =>
    Effect.map(Ref.get(tracked), (runs) => Option.fromNullishOr(runs.get(runId)))

  const turnRows = (runId: string, where: 'all' | 'open' | { readonly turnId: string }) =>
    (where === 'all'
      ? sql`SELECT * FROM creator_turns WHERE run_id = ${runId} ORDER BY position`
      : where === 'open'
        ? sql`SELECT * FROM creator_turns WHERE run_id = ${runId} AND to_sha IS NULL`
        : sql`SELECT * FROM creator_turns WHERE run_id = ${runId} AND turn_id = ${where.turnId}`
    ).pipe(Effect.flatMap(decodeTurnRows), Effect.orDie)

  const branchHead = (worktree: WorktreeInfo) =>
    git.resolveCommit(metaDirectory, `refs/heads/${worktree.branch}`).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new BranchMissing({ branch: worktree.branch })),
          onSome: Effect.succeed
        })
      )
    )

  const unmergedCount = (worktree: WorktreeInfo) =>
    git.log(metaDirectory, ['--format=%H', `HEAD..refs/heads/${worktree.branch}`]).pipe(
      Effect.map((output) => output.split('\n').filter((line) => line.trim() !== '').length),
      Effect.catchTag('GitError', (error) =>
        Effect.as(
          Effect.logWarning('Could not count unmerged Creator commits', {
            branch: worktree.branch,
            error: error.message
          }),
          0
        )
      )
    )

  const closeTurn = (runId: string, open: TurnRow, head: string) =>
    Effect.gen(function* () {
      const commits =
        head === open.from_sha
          ? []
          : parseCommits(
              yield* git.log(metaDirectory, [
                '--reverse',
                '--format=%H%x1f%s',
                `${open.from_sha}..${head}`
              ])
            )
      const list = open.plugins.length === 0 ? [] : yield* plugins.list
      const loads = open.plugins.map((name) => {
        const status = list.find((info) => info.name === name)?.status
        return {
          plugin: name,
          loaded: status?._tag === 'Loaded' && status.reloadError === undefined
        }
      })
      yield* Effect.logInfo('A Creator turn ended', {
        runId,
        turnId: open.turn_id,
        commits: commits.length,
        loads: loads.length
      })
      const write: Write =
        commits.length === 0 && loads.length === 0
          ? Effect.asVoid(
              sql`DELETE FROM creator_turns WHERE run_id = ${runId} AND turn_id = ${open.turn_id}`
            )
          : Effect.asVoid(sql`UPDATE creator_turns SET to_sha = ${head},
              commits = ${encodeCommits(commits)}, loads = ${encodeLoads(loads)}
              WHERE run_id = ${runId} AND turn_id = ${open.turn_id}`)
      return write
    })

  const startTurn = (runId: string, run: TrackedRun, event: StoredEvent) =>
    Effect.gen(function* () {
      if (event._tag !== 'PaneUserMessagesSent') return NO_WRITE
      const messageIds = event.messages.map((message) => message.id)
      const turnId = messageIds[0]
      if (turnId === undefined) return NO_WRITE
      if ((yield* turnRows(runId, { turnId })).length > 0) return NO_WRITE
      const [open] = yield* turnRows(runId, 'open')
      const from = yield* branchHead(run.worktree)
      const close = open === undefined ? NO_WRITE : yield* closeTurn(runId, open, from)
      const [last] = yield* sql<{ readonly position: number | null }>`
        SELECT MAX(position) AS position FROM creator_turns WHERE run_id = ${runId}`.pipe(
        Effect.orDie
      )
      yield* Effect.logInfo('A Creator turn started', { runId, turnId })
      return close.pipe(
        Effect.andThen(
          sql`INSERT INTO creator_turns ${sql.insert({
            run_id: runId,
            turn_id: turnId,
            position: (last?.position ?? 0) + 1,
            message_ids: encodeStrings(messageIds),
            from_sha: from,
            to_sha: null,
            commits: '[]',
            plugins: '[]',
            loads: '[]',
            revert_sha: null
          })}`
        )
      )
    })

  const notePlugin = (runId: string, name: string) =>
    Effect.gen(function* () {
      const [open] = yield* turnRows(runId, 'open')
      if (open === undefined || open.plugins.includes(name)) return NO_WRITE
      return sql`UPDATE creator_turns SET plugins = ${encodeStrings([...open.plugins, name])}
                 WHERE run_id = ${runId} AND turn_id = ${open.turn_id}`.pipe(Effect.asVoid)
    })

  const writesFor = (runId: string, run: TrackedRun, event: StoredEvent) =>
    Effect.gen(function* () {
      if (event._tag === 'ToolCallCompleted') {
        const name = event.input.name
        return PLUGIN_TOOLS.has(event.toolName) && typeof name === 'string'
          ? yield* notePlugin(runId, name)
          : NO_WRITE
      }
      const boundary = boundaryOf(event)
      if (Option.isNone(boundary)) return NO_WRITE
      if (boundary.value._tag === 'TurnStart') return yield* startTurn(runId, run, event)
      const [open] = yield* turnRows(runId, 'open')
      return open === undefined
        ? NO_WRITE
        : Effect.asVoid(yield* closeTurn(runId, open, yield* branchHead(run.worktree)))
    }).pipe(
      Effect.catchTag('GitError', (error) =>
        Effect.as(
          Effect.logWarning('Skipped a Creator run event git could not read', {
            runId,
            error: error.message
          }),
          NO_WRITE
        )
      ),
      Effect.catchTag('BranchMissing', (error) =>
        Effect.as(
          Effect.logWarning('Skipped a Creator run event: its branch is gone', {
            runId,
            branch: error.branch
          }),
          NO_WRITE
        )
      )
    )

  const fold = (committed: CommittedEvent) =>
    Effect.gen(function* () {
      const { runId, sequence, event } = committed
      const run = yield* trackedRun(runId)
      if (Option.isNone(run) || sequence <= run.value.lastSequence) return
      const writes = yield* writesFor(runId, run.value, event)
      yield* Ref.update(tracked, (runs) =>
        new Map(runs).set(runId, { ...run.value, lastSequence: sequence })
      )
      if (writes === NO_WRITE) return
      yield* sql
        .withTransaction(
          writes.pipe(
            Effect.andThen(
              sql`UPDATE creator_runs SET last_sequence = ${sequence} WHERE run_id = ${runId}`
            )
          )
        )
        .pipe(Effect.orDie)
      yield* PubSub.publish(changed, runId)
    })

  const track = (runId: string, worktree: WorktreeInfo, lastSequence: number) =>
    sql`INSERT INTO creator_runs ${sql.insert({
      run_id: runId,
      last_sequence: lastSequence,
      worktree: encodeWorktree(worktree),
      last_merge_sha: null
    })}`.pipe(
      Effect.orDie,
      Effect.andThen(
        Ref.update(tracked, (runs) => new Map(runs).set(runId, { worktree, lastSequence }))
      ),
      Effect.andThen(Effect.logInfo('Tracking a Creator run', { runId, branch: worktree.branch }))
    )

  const catchUp = Effect.gen(function* () {
    const runs = yield* Ref.get(tracked)
    yield* Effect.forEach(
      runs.keys(),
      (runId) =>
        deps.runEvents.readTagged(runId, FOLDED_TAGS).pipe(
          Effect.flatMap((events) => Effect.forEach(events, fold, { discard: true })),
          Effect.catchTag('RunEventReadError', (error) =>
            Effect.logWarning('Could not read a Creator run event log', {
              runId,
              error: String(error.cause)
            })
          )
        ),
      { discard: true }
    )
    yield* Effect.logInfo('Creator turn changes caught up', { runs: runs.size })
  })

  const lastMerge = (runId: string) =>
    sql<{
      readonly last_merge_sha: string | null
    }>`SELECT last_merge_sha FROM creator_runs WHERE run_id = ${runId}`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]?.last_merge_sha ?? null)
    )

  const state = (runId: string) =>
    Effect.gen(function* () {
      const run = yield* trackedRun(runId)
      if (Option.isNone(run)) return EMPTY_STATE
      const turns = yield* turnRows(runId, 'all')
      const merge = yield* lastMerge(runId)
      return {
        turns: turns.map(toChange),
        unmerged: yield* unmergedCount(run.value.worktree),
        lastMerge: merge === null ? null : { sha: merge }
      }
    })

  const follow = (runId: string) =>
    Stream.unwrap(
      Effect.map(PubSub.subscribe(changed), (subscription) =>
        Stream.concat(
          Stream.make(runId),
          Stream.fromSubscription(subscription).pipe(Stream.filter((id) => id === runId))
        )
      )
    ).pipe(Stream.mapEffect(() => state(runId)))

  const unmerged = Effect.gen(function* () {
    const runs = yield* Ref.get(tracked)
    return yield* Effect.filter(
      [...runs].map(([runId, run]) => ({ runId, worktree: run.worktree })),
      (run) => Effect.map(unmergedCount(run.worktree), (count) => count > 0),
      { concurrency: 4 }
    )
  })

  const revertFailed = (reason: RevertFailed['reason'], message: string) =>
    failLogged('Could not revert a Creator turn', new RevertFailed({ reason, message }))

  const revert = (runId: string, turnId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const run = yield* trackedRun(runId)
        const [row] = yield* turnRows(runId, { turnId })
        if (Option.isNone(run) || row === undefined) {
          return yield* revertFailed('nothing-to-revert', 'This turn has no changes to revert.')
        }
        if (row.revert_sha !== null) return toChange(row)
        const [newest, ...older] = [...row.commits].reverse().map((commit) => commit.sha)
        if (row.to_sha === null || newest === undefined) {
          return yield* revertFailed('nothing-to-revert', 'This turn has no commits to revert.')
        }
        const { worktree } = run.value
        yield* deps
          .reattach(worktree, runId)
          .pipe(
            Effect.catchTag('WorktreeReattachError', (error) =>
              revertFailed('git', String(error.cause))
            )
          )
        const result = yield* git
          .revert(worktree.path, [newest, ...older], {
            message: revertMessage(row.commits),
            author: AUTHOR
          })
          .pipe(Effect.catchTag('GitError', (error) => revertFailed('git', gitReason(error))))
        if (result._tag === 'RevertConflict') return yield* revertFailed('conflict', result.message)
        yield* sql`UPDATE creator_turns SET revert_sha = ${result.commit}
                   WHERE run_id = ${runId} AND turn_id = ${turnId}`.pipe(Effect.orDie)
        yield* Effect.logInfo('Reverted a Creator turn', { runId, turnId, sha: result.commit })
        yield* PubSub.publish(changed, runId)
        const files = yield* git.changedFiles(metaDirectory, row.from_sha, row.to_sha).pipe(
          Effect.catchTag('GitError', (error) =>
            Effect.as(
              Effect.logWarning('Could not list the files a reverted turn changed', {
                runId,
                error: error.message
              }),
              []
            )
          )
        )
        yield* reloadPlugins(plugins, pluginsTouched(yield* plugins.list, worktree.path, files))
        return toChange({ ...row, revert_sha: result.commit })
      })
    )

  const mergeFailed = (reason: MergeFailed['reason'], message: string) =>
    failLogged('Could not merge a Creator thread', new MergeFailed({ reason, message }))

  const moveOverrides = (worktree: WorktreeInfo) =>
    Effect.gen(function* () {
      const moved = overridesInside(yield* plugins.list, worktree.path)
      return yield* Effect.filter(moved, ({ name, folder }) =>
        plugins.setOverride(name, joinInside(metaDirectory, folder)).pipe(
          Effect.tap((result) =>
            result._tag === 'Rejected'
              ? Effect.logWarning('A merged plugin keeps its worktree override', {
                  plugin: name,
                  message: result.message
                })
              : Effect.logInfo('Moved a plugin override to the meta repo', { plugin: name })
          ),
          Effect.map((result) => result._tag !== 'Rejected')
        )
      )
    })

  const merge = (runId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const run = yield* trackedRun(runId)
        if (Option.isNone(run)) {
          return yield* mergeFailed('nothing-to-merge', 'This is not a Creator thread.')
        }
        const { worktree } = run.value
        if ((yield* unmergedCount(worktree)) === 0) {
          return yield* mergeFailed('nothing-to-merge', 'The meta repo already has every commit.')
        }
        const result = yield* Effect.gen(function* () {
          const before = yield* git.resolveCommit(metaDirectory, 'HEAD')
          const merged = yield* git.merge(metaDirectory, worktree.branch, {
            message: `Merge ${worktree.branch}`,
            author: AUTHOR
          })
          if (merged._tag === 'MergeConflict') return { merged, files: [] }
          const files = Option.isNone(before)
            ? []
            : yield* git.changedFiles(metaDirectory, before.value, merged.commit)
          return { merged, files }
        }).pipe(Effect.catchTag('GitError', (error) => mergeFailed('git', gitReason(error))))
        if (result.merged._tag === 'MergeConflict') {
          return yield* mergeFailed('conflict', result.merged.message)
        }
        const sha = result.merged.commit
        yield* sql`UPDATE creator_runs SET last_merge_sha = ${sha} WHERE run_id = ${runId}`.pipe(
          Effect.orDie
        )
        yield* Effect.logInfo('Merged a Creator thread', { runId, branch: worktree.branch, sha })
        const moved = yield* moveOverrides(worktree)
        const touched = pluginsTouched(yield* plugins.list, metaDirectory, result.files)
        yield* PubSub.publish(changed, runId)
        yield* reloadPlugins(plugins, [...moved.map(({ name }) => name), ...touched])
        return { sha }
      })
    )

  return { track, catchUp, fold, state, follow, unmerged, revert, merge }
})

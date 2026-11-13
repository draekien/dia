import { PermissionMode, RunStatus, SessionId, ThinkingLevel, WorktreeInfo } from '@dia/plugin'
import { Clock, Effect, Option, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

/** What a run opens with, as its row stores it; `cwd` is the worktree path when it has one. */
export const StoredSpec = Schema.Struct({
  sourceCwd: Schema.String,
  model: Schema.String,
  thinkingLevel: ThinkingLevel,
  permissionMode: PermissionMode,
  worktree: Schema.NullOr(WorktreeInfo)
})
export type StoredSpec = typeof StoredSpec.Type

/** One run's row. */
export interface RunRow {
  readonly runId: string
  readonly spec: StoredSpec
  readonly sessionId: Option.Option<SessionId>
  readonly status: RunStatus
  readonly hasTab: boolean
}

const SpecJson = Schema.fromJsonString(StoredSpec)
const encodeSpec = Schema.encodeSync(SpecJson)
const decodeRow = Schema.decodeUnknownOption(
  Schema.Struct({
    run_id: Schema.String,
    spec_json: SpecJson,
    session_id: Schema.NullOr(SessionId),
    status: RunStatus,
    has_tab: Schema.Number
  })
)

const toRow = (raw: unknown): Option.Option<RunRow> =>
  Option.map(decodeRow(raw), (row) => ({
    runId: row.run_id,
    spec: row.spec_json,
    sessionId: Option.fromNullishOr(row.session_id),
    status: row.status,
    hasTab: row.has_tab === 1
  }))

/** The working directory of a run with `spec`. */
export const cwdOf = (spec: StoredSpec): string => spec.worktree?.path ?? spec.sourceCwd

const logged =
  (operation: string, runId: string) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.tapError((cause) =>
        Effect.logError('A run row operation failed', { operation, runId, cause })
      )
    )

/**
 * The `runs`, `applied_calls` and `settings` tables of `dia-runs`' database. Writes that fail are
 * logged and leave the row as it was; reads that fail are logged and read as absent. Requires the
 * plugin's `SqlClient`.
 */
export const makeRunRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const get = (runId: string) =>
    sql`SELECT * FROM runs WHERE run_id = ${runId}`.pipe(
      Effect.map((rows) => Option.flatMap(Option.fromUndefinedOr(rows[0]), toRow)),
      logged('get', runId),
      Effect.orElseSucceed(() => Option.none<RunRow>())
    )

  const list = sql`SELECT * FROM runs ORDER BY created_at`.pipe(
    Effect.map((rows) => rows.flatMap((raw) => Option.toArray(toRow(raw)))),
    logged('list', '*'),
    Effect.orElseSucceed((): ReadonlyArray<RunRow> => [])
  )

  const write = (operation: string, runId: string, statement: Effect.Effect<unknown, unknown>) =>
    statement.pipe(
      logged(operation, runId),
      Effect.ignore,
      Effect.andThen(Effect.logDebug('Wrote a run row', { operation, runId }))
    )

  const upsert = Effect.fnUntraced(function* (
    runId: string,
    spec: StoredSpec,
    sessionId: Option.Option<SessionId>,
    hasTab: boolean
  ) {
    const createdAt = yield* Clock.currentTimeMillis
    yield* write(
      'upsert',
      runId,
      sql`INSERT INTO runs (run_id, spec_json, session_id, status, has_tab, created_at)
        VALUES (${runId}, ${encodeSpec(spec)}, ${Option.getOrNull(sessionId)}, 'idle',
          ${hasTab ? 1 : 0}, ${createdAt})
        ON CONFLICT (run_id) DO UPDATE SET
          spec_json = excluded.spec_json,
          session_id = COALESCE(excluded.session_id, runs.session_id),
          has_tab = MAX(runs.has_tab, excluded.has_tab),
          status = CASE WHEN runs.status = 'archived' THEN 'idle' ELSE runs.status END`
    )
  })

  const setSpec = (runId: string, spec: StoredSpec) =>
    write(
      'setSpec',
      runId,
      sql`UPDATE runs SET spec_json = ${encodeSpec(spec)} WHERE run_id = ${runId}`
    )

  const setStatus = (runId: string, status: RunStatus) =>
    write('setStatus', runId, sql`UPDATE runs SET status = ${status} WHERE run_id = ${runId}`)

  const setSessionId = (runId: string, sessionId: Option.Option<SessionId>) =>
    write(
      'setSessionId',
      runId,
      sql`UPDATE runs SET session_id = ${Option.getOrNull(sessionId)} WHERE run_id = ${runId}`
    )

  const setHasTab = (runId: string) =>
    write('setHasTab', runId, sql`UPDATE runs SET has_tab = 1 WHERE run_id = ${runId}`)

  const remove = (runId: string) =>
    write('remove', runId, sql`DELETE FROM runs WHERE run_id = ${runId}`)

  /**
   * Records `requestId` as applied to run `runId` by call `tag`. True when it was not recorded
   * before, so the caller applies the call; false for a call already applied (or being applied).
   */
  const claim = Effect.fnUntraced(function* (requestId: string, runId: string, tag: string) {
    const appliedAt = yield* Clock.currentTimeMillis
    const inserted = yield* sql`INSERT INTO applied_calls (request_id, run_id, tag, applied_at)
      VALUES (${requestId}, ${runId}, ${tag}, ${appliedAt})
      ON CONFLICT (request_id) DO NOTHING RETURNING request_id`.pipe(
      logged('claim', runId),
      Effect.orElseSucceed(() => [{}])
    )
    return inserted.length > 0
  })

  const getSetting = <A, I>(key: string, schema: Schema.Codec<A, I>) =>
    sql`SELECT value_json FROM settings WHERE key = ${key}`.pipe(
      Effect.map((rows) =>
        Option.flatMap(Option.fromUndefinedOr(rows[0]?.value_json), (json) =>
          Schema.decodeUnknownOption(Schema.fromJsonString(schema))(json)
        )
      ),
      logged('getSetting', key),
      Effect.orElseSucceed(() => Option.none<A>())
    )

  const setSetting = <A, I>(key: string, schema: Schema.Codec<A, I>, value: A) =>
    Effect.suspend(() =>
      write(
        'setSetting',
        key,
        sql`INSERT INTO settings (key, value_json)
          VALUES (${key}, ${Schema.encodeSync(Schema.fromJsonString(schema))(value)})
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`
      )
    )

  return {
    get,
    list,
    upsert,
    setSpec,
    setStatus,
    setSessionId,
    setHasTab,
    remove,
    claim,
    getSetting,
    setSetting
  }
})

/** The run row store {@link makeRunRows} builds. */
export type RunRows = Effect.Success<typeof makeRunRows>

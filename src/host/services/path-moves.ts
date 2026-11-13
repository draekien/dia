import type { PathsMoved } from '@shared/plugin/paths-moved'
import { Clock, Context, Data, Effect, Exit, Layer, type Scope, Semaphore } from 'effect'
import { SqlClient } from 'effect/sql'

/** `host.db` could not be read or written while recording a data migration. Carries the `SqlError`. */
export class PathMovesError extends Data.TaggedError('PathMovesError')<{
  readonly cause: unknown
}> {}

/** What a path owner does with one {@link PathsMoved}: rewrite the paths it stores. */
export type PathsMovedHandler = (move: PathsMoved) => Effect.Effect<void, unknown>

/**
 * The record of plugin data migrations and of the folders they moved, kept in `host.db`. The Host
 * plugin loader records each migration it runs; every owner of stored paths subscribes and is
 * given each move it has not acknowledged. Provide it with {@link PathMovesLive}.
 */
export class PathMoves extends Context.Service<
  PathMoves,
  {
    /** Whether `plugin` has run its data migration `id`. */
    readonly hasRun: (plugin: string, id: string) => Effect.Effect<boolean, PathMovesError>
    /** Records that `plugin` ran migration `id` and moved nothing. */
    readonly recordRun: (plugin: string, id: string) => Effect.Effect<void, PathMovesError>
    /**
     * Records that `plugin` ran migration `id` and that it moved `move.from` to `move.to`, in one
     * transaction, then gives the move to every subscribed owner before it succeeds. An owner's
     * failure is logged and does not fail the record.
     */
    readonly recordMove: (
      plugin: string,
      id: string,
      move: PathsMoved
    ) => Effect.Effect<void, PathMovesError>
    /**
     * Subscribes `owner` until the calling scope closes. Gives `handle` every recorded move
     * `owner` has not acknowledged, oldest first, now and after each later `recordMove`; a move
     * is acknowledged when `handle` succeeds. When `handle` fails, the failure is logged and the
     * remaining moves wait for the next subscription or record. `handle` must not call
     * `subscribe` or `recordMove`. A later subscription under the same `owner` replaces this one.
     */
    readonly subscribe: (
      owner: string,
      handle: PathsMovedHandler
    ) => Effect.Effect<void, never, Scope.Scope>
  }
>()('PathMoves') {}

interface MoveRow {
  readonly sequence: number
  readonly from_path: string
  readonly to_path: string
}

/** Builds {@link PathMoves} over `host.db`. Requires the `SqlClient` of `makeHostDatabaseLive`. */
export const PathMovesLive = Layer.effect(
  PathMoves,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const owners = new Map<string, PathsMovedHandler>()
    const deliveryLock = yield* Semaphore.make(1)

    const deliver = (owner: string, handle: PathsMovedHandler) =>
      Effect.gen(function* () {
        const rows = yield* sql<MoveRow>`SELECT sequence, from_path, to_path FROM paths_moved
          WHERE sequence NOT IN (SELECT sequence FROM path_move_acks WHERE owner = ${owner})
          ORDER BY sequence`
        for (const row of rows) {
          const move = { from: row.from_path, to: row.to_path }
          const exit = yield* Effect.exit(Effect.suspend(() => handle(move)))
          if (Exit.isFailure(exit)) {
            yield* Effect.logError('A path owner could not apply a moved folder', {
              owner,
              ...move,
              cause: exit.cause
            })
            return
          }
          yield* sql`INSERT INTO path_move_acks (owner, sequence) VALUES (${owner}, ${row.sequence})`
          yield* Effect.logInfo('Path owner applied a moved folder', { owner, ...move })
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError('Could not deliver moved folders to a path owner', { owner, cause })
        ),
        deliveryLock.withPermits(1)
      )

    const hasRun = (plugin: string, id: string) =>
      sql<{ readonly found: number }>`SELECT 1 AS found FROM data_migrations
        WHERE plugin = ${plugin} AND migration_id = ${id}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError((cause) => new PathMovesError({ cause }))
      )

    const insertRun = (plugin: string, id: string) =>
      Effect.flatMap(
        Clock.currentTimeMillis,
        (now) =>
          sql`INSERT INTO data_migrations (plugin, migration_id, ran_at) VALUES (${plugin}, ${id}, ${now})`
      )

    const recordRun = (plugin: string, id: string) =>
      insertRun(plugin, id).pipe(
        Effect.tap(() => Effect.logInfo('Data migration recorded; nothing moved', { plugin, id })),
        Effect.mapError((cause) => new PathMovesError({ cause }))
      )

    const recordMove = (plugin: string, id: string, move: PathsMoved) =>
      Effect.gen(function* () {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* insertRun(plugin, id)
              const now = yield* Clock.currentTimeMillis
              yield* sql`INSERT INTO paths_moved (from_path, to_path, moved_at)
                VALUES (${move.from}, ${move.to}, ${now})`
            })
          )
          .pipe(Effect.mapError((cause) => new PathMovesError({ cause })))
        yield* Effect.logInfo('Data migration moved a folder', { plugin, id, ...move })
        for (const [owner, handle] of owners) yield* deliver(owner, handle)
      })

    const subscribe = (owner: string, handle: PathsMovedHandler) =>
      Effect.acquireRelease(
        Effect.sync(() => owners.set(owner, handle)),
        () =>
          Effect.sync(() => {
            if (owners.get(owner) === handle) owners.delete(owner)
          })
      ).pipe(Effect.andThen(deliver(owner, handle)))

    return PathMoves.of({ hasRun, recordRun, recordMove, subscribe })
  })
)

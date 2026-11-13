import type { DataMigration, PluginManifest } from '@shared/plugin/manifest'
import type { PathsMoved } from '@shared/plugin/paths-moved'
import { errorMessage, PluginLoadError } from '@shared/plugin/plugin-registry'
import { Cause, Effect, FileSystem, Option, Path, Predicate } from 'effect'
import { PathMoves } from '../services/path-moves'

/**
 * Runs the data migrations `manifest` declares that plugin `name` has not run yet, before the
 * plugin loads from `root`. Fails with a {@link PluginLoadError} naming the paths when a folder
 * cannot be moved or both the old and the new folder exist; the plugin must not load then.
 */
export type DataMigrationRunner = (
  name: string,
  manifest: PluginManifest,
  root: string
) => Effect.Effect<void, PluginLoadError>

const migrationError = (name: string, migration: DataMigration, cause: unknown) =>
  new PluginLoadError({
    message: `Data migration ${migration.id} of ${name} could not be recorded: ${errorMessage(cause)}`
  })

/**
 * Builds the {@link DataMigrationRunner} for plugin data folders `<userDataPath>/plugins/<name>`.
 * `importModule(root, file)` imports a plugin module, as the plugin loader imports an entry; it
 * loads a migration's `before` module. Requires {@link PathMoves}, `FileSystem` and `Path`.
 */
export const makeDataMigrations = (
  userDataPath: string,
  importModule: (root: string, file: string) => Promise<unknown>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const moves = yield* PathMoves

    const exists = (folder: string) => fs.exists(folder).pipe(Effect.orElseSucceed(() => false))

    const runBefore = Effect.fn('DataMigrations.runBefore')(function* (
      root: string,
      file: string,
      move: PathsMoved
    ) {
      const module = yield* Effect.tryPromise(() => importModule(root, path.resolve(root, file)))
      const prepare = Predicate.hasProperty(module, 'default') ? module.default : undefined
      if (!Predicate.isFunction(prepare)) {
        return yield* new PluginLoadError({
          message: `"${file}" has no function as its default export`
        })
      }
      yield* Effect.suspend(() => prepare(move) as Effect.Effect<void, unknown>)
    })

    const beforeFailure = (root: string, file: string, move: PathsMoved) =>
      runBefore(root, file, move).pipe(
        Effect.as(Option.none<string>()),
        Effect.catchCause((cause) =>
          Effect.logWarning('A data migration could not prepare its folder', {
            file,
            cause
          }).pipe(Effect.as(Option.some(Cause.pretty(cause))))
        )
      )

    const runOne = Effect.fn('DataMigrations.runOne')(function* (
      name: string,
      root: string,
      migration: DataMigration
    ) {
      const move = {
        from: path.join(userDataPath, ...migration.from.split('/')),
        to: path.join(userDataPath, 'plugins', name)
      }
      const fromExists = yield* exists(move.from)
      const toExists = yield* exists(move.to)
      if (!fromExists) {
        const record = toExists
          ? moves.recordMove(name, migration.id, move)
          : moves.recordRun(name, migration.id)
        return yield* record.pipe(
          Effect.mapError((error) => migrationError(name, migration, error))
        )
      }
      if (toExists) {
        return yield* new PluginLoadError({
          message: `Cannot move ${move.from} to ${move.to}: both folders exist. Move or delete one of them and load ${name} again.`
        })
      }
      const prepared =
        migration.before === undefined
          ? Option.none<string>()
          : yield* beforeFailure(root, migration.before, move)
      yield* fs.rename(move.from, move.to).pipe(
        Effect.mapError(
          (error) =>
            new PluginLoadError({
              message: [
                `Cannot move ${move.from} to ${move.to}: ${error.message}.`,
                'Close any program using files in that folder and load the plugin again.',
                ...Option.toArray(
                  Option.map(prepared, (failure) => `Preparing the move failed: ${failure}`)
                )
              ].join(' ')
            })
        )
      )
      yield* moves
        .recordMove(name, migration.id, move)
        .pipe(Effect.mapError((error) => migrationError(name, migration, error)))
    })

    const run: DataMigrationRunner = (name, manifest, root) =>
      Effect.forEach(
        manifest.dataMigrations ?? [],
        (migration) =>
          moves.hasRun(name, migration.id).pipe(
            Effect.mapError((error) => migrationError(name, migration, error)),
            Effect.flatMap((ran) => (ran ? Effect.void : runOne(name, root, migration)))
          ),
        { discard: true }
      ).pipe(
        Effect.tapError((error) =>
          Effect.logError('Plugin data migration failed', { plugin: name, message: error.message })
        )
      )
    return run
  })

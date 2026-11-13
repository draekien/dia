import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import type { PluginManifest } from '@shared/plugin/manifest'
import type { PathsMoved } from '@shared/plugin/paths-moved'
import { Effect, Exit, FileSystem, Layer, Path, PlatformError, type Scope } from 'effect'
import { makeHostDatabaseLive } from '../services/database'
import { PathMoves, PathMovesLive } from '../services/path-moves'
import { makeDataMigrations } from './data-migrations'

const manifest = (before?: string): PluginManifest => ({
  name: 'dia-worktrees',
  api: '0.0.37',
  category: 'feature',
  dataMigrations: [
    { id: '1_dia_prefix', from: 'plugins/worktrees', ...(before === undefined ? {} : { before }) }
  ]
})

const lockedRename = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) => ({
    ...fs,
    rename: (from: string) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: 'PermissionDenied',
          module: 'FileSystem',
          method: 'rename',
          pathOrDescriptor: from
        })
      )
  }))
).pipe(Layer.provide(NodeServices.layer))

interface Folders {
  readonly userData: string
  readonly from: string
  readonly to: string
}

const inUserData = <A, E>(
  body: (
    folders: Folders
  ) => Effect.Effect<A, E, PathMoves | FileSystem.FileSystem | Path.Path | Scope.Scope>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const userData = yield* fs.makeTempDirectoryScoped()
    const folders = {
      userData,
      from: path.join(userData, 'plugins', 'worktrees'),
      to: path.join(userData, 'plugins', 'dia-worktrees')
    }
    return yield* body(folders).pipe(
      Effect.provide(Layer.provide(PathMovesLive, makeHostDatabaseLive(userData)))
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const noModules = () => Promise.reject(new Error('no module expected'))

const seed = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(folder, { recursive: true })
    yield* fs.writeFileString(`${folder}/data.db`, 'issues')
  })

const movesSeenBy = (owner: string) =>
  Effect.gen(function* () {
    const received: Array<PathsMoved> = []
    yield* (yield* PathMoves).subscribe(owner, (move) =>
      Effect.sync(() => void received.push(move))
    )
    return received
  })

describe('makeDataMigrations', () => {
  it.effect('moves the old folder to the plugin data folder with its files', () =>
    inUserData((folders) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* seed(folders.from)
        const migrate = yield* makeDataMigrations(folders.userData, noModules)

        yield* migrate('dia-worktrees', manifest(), '/plugin')

        assert.deepStrictEqual(
          [yield* fs.exists(folders.from), yield* fs.readFileString(`${folders.to}/data.db`)],
          [false, 'issues']
        )
      })
    )
  )

  it.effect('records the move for path owners', () =>
    inUserData((folders) =>
      Effect.gen(function* () {
        yield* seed(folders.from)
        const migrate = yield* makeDataMigrations(folders.userData, noModules)

        yield* migrate('dia-worktrees', manifest(), '/plugin')

        assert.deepStrictEqual(yield* movesSeenBy('workspace'), [
          { from: folders.from, to: folders.to }
        ])
      })
    )
  )

  it.effect('fails naming both folders when both exist, and moves nothing', () =>
    inUserData((folders) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* seed(folders.from)
        yield* fs.makeDirectory(folders.to, { recursive: true })
        const migrate = yield* makeDataMigrations(folders.userData, noModules)

        const error = yield* Effect.flip(migrate('dia-worktrees', manifest(), '/plugin'))

        assert.include(error.message, folders.from)
        assert.include(error.message, folders.to)
        assert.isTrue(yield* fs.exists(`${folders.from}/data.db`))
        assert.deepStrictEqual(yield* movesSeenBy('workspace'), [])
      })
    )
  )

  it.effect('does not run a migration twice', () =>
    inUserData((folders) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* seed(folders.from)
        const migrate = yield* makeDataMigrations(folders.userData, noModules)
        yield* migrate('dia-worktrees', manifest(), '/plugin')
        yield* seed(folders.from)

        const second = yield* Effect.exit(migrate('dia-worktrees', manifest(), '/plugin'))

        assert.isTrue(Exit.isSuccess(second))
        assert.isTrue(yield* fs.exists(`${folders.from}/data.db`))
      })
    )
  )

  it.effect(
    'records the move when only the new folder exists, as after a crash past the rename',
    () =>
      inUserData((folders) =>
        Effect.gen(function* () {
          yield* seed(folders.to)
          const migrate = yield* makeDataMigrations(folders.userData, noModules)

          yield* migrate('dia-worktrees', manifest(), '/plugin')

          assert.deepStrictEqual(yield* movesSeenBy('workspace'), [
            { from: folders.from, to: folders.to }
          ])
        })
      )
  )

  it.effect('records no move when neither folder exists', () =>
    inUserData((folders) =>
      Effect.gen(function* () {
        const migrate = yield* makeDataMigrations(folders.userData, noModules)

        yield* migrate('dia-worktrees', manifest(), '/plugin')

        assert.isTrue(yield* (yield* PathMoves).hasRun('dia-worktrees', '1_dia_prefix'))
        assert.deepStrictEqual(yield* movesSeenBy('workspace'), [])
      })
    )
  )

  it.effect('runs the before module with the move before the folder moves', () =>
    inUserData((folders) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* seed(folders.from)
        const seen: Array<{ readonly move: PathsMoved; readonly fromExisted: boolean }> = []
        const importModule = async () => ({
          default: (move: PathsMoved) =>
            fs
              .exists(move.from)
              .pipe(
                Effect.tap((fromExisted) => Effect.sync(() => seen.push({ move, fromExisted })))
              )
        })
        const migrate = yield* makeDataMigrations(folders.userData, importModule)

        yield* migrate('dia-worktrees', manifest('data-migration.ts'), '/plugin')

        assert.deepStrictEqual(seen, [
          { move: { from: folders.from, to: folders.to }, fromExisted: true }
        ])
      })
    )
  )

  it.effect('fails naming the folders and records nothing when the rename fails', () =>
    inUserData((folders) =>
      Effect.gen(function* () {
        yield* seed(folders.from)
        const migrate = yield* makeDataMigrations(folders.userData, noModules).pipe(
          Effect.provide(lockedRename)
        )

        const error = yield* Effect.flip(migrate('dia-worktrees', manifest(), '/plugin'))

        assert.include(error.message, folders.from)
        assert.include(error.message, folders.to)
        assert.isFalse(yield* (yield* PathMoves).hasRun('dia-worktrees', '1_dia_prefix'))
      })
    )
  )

  it.effect('includes a before failure in the error of a failed rename', () =>
    inUserData((folders) =>
      Effect.gen(function* () {
        yield* seed(folders.from)
        const importModule = async () => ({ default: () => Effect.fail('fsmonitor still running') })
        const migrate = yield* makeDataMigrations(folders.userData, importModule).pipe(
          Effect.provide(lockedRename)
        )

        const error = yield* Effect.flip(
          migrate('dia-worktrees', manifest('data-migration.ts'), '/plugin')
        )

        assert.include(error.message, 'fsmonitor still running')
      })
    )
  )
})

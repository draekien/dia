import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Option, Path } from 'effect'
import { type ModuleImporter, makeHostPluginLoader } from './plugin-loader'

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const pluginDirectory = (manifest: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped()
    if (manifest !== undefined) yield* fs.writeFileString(path.join(root, 'plugin.json'), manifest)
    return { root, path }
  })

const recordingImporter = (result: () => Promise<unknown>) => {
  const calls: Array<{ root: string; entry: string }> = []
  const importer: ModuleImporter = (root, entry) => {
    calls.push({ root, entry })
    return result()
  }
  return { importer, calls }
}

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | import('effect').Scope.Scope>
) => effect.pipe(Effect.scoped, Effect.provide(platform))

describe('host plugin loader', () => {
  it.effect('imports the manifest host entry and returns its default export as the setup', () =>
    run(
      Effect.gen(function* () {
        const setup = () => Effect.void
        const { root, path } = yield* pluginDirectory(
          JSON.stringify({ name: 'chat', api: '1', host: 'src/host.ts' })
        )
        const { importer, calls } = recordingImporter(() => Promise.resolve({ default: setup }))
        const loader = yield* makeHostPluginLoader(importer)

        const loaded = yield* loader.load(root)
        const importedBeforeResolve = calls.length
        const resolved = yield* loaded.resolveSetup

        assert.deepStrictEqual(loaded.manifest, { name: 'chat', api: '1', host: 'src/host.ts' })
        assert.strictEqual(importedBeforeResolve, 0)
        assert.strictEqual(Option.getOrThrow(resolved), setup)
        assert.deepStrictEqual(calls, [{ root, entry: path.join(root, 'src', 'host.ts') }])
      })
    )
  )

  it.effect('returns no setup and imports nothing for a manifest without a host entry', () =>
    run(
      Effect.gen(function* () {
        const { root } = yield* pluginDirectory(
          JSON.stringify({ name: 'theme', api: '1', renderer: 'renderer.tsx' })
        )
        const { importer, calls } = recordingImporter(() => Promise.resolve({}))
        const loader = yield* makeHostPluginLoader(importer)

        const loaded = yield* loader.load(root)
        const resolved = yield* loaded.resolveSetup

        assert.isTrue(Option.isNone(resolved))
        assert.deepStrictEqual(calls, [])
      })
    )
  )

  it.effect('fails with the manifest path when plugin.json is missing', () =>
    run(
      Effect.gen(function* () {
        const { root, path } = yield* pluginDirectory(undefined)
        const loader = yield* makeHostPluginLoader(
          recordingImporter(() => Promise.resolve({})).importer
        )

        const failure = yield* Effect.flip(loader.load(root))

        assert.include(failure.message, `Cannot read "${path.join(root, 'plugin.json')}"`)
      })
    )
  )

  it.effect('fails when plugin.json is not a valid manifest', () =>
    run(
      Effect.gen(function* () {
        const { root, path } = yield* pluginDirectory(JSON.stringify({ name: 'Not Valid', api: 1 }))
        const loader = yield* makeHostPluginLoader(
          recordingImporter(() => Promise.resolve({})).importer
        )

        const failure = yield* Effect.flip(loader.load(root))

        assert.include(failure.message, `Invalid "${path.join(root, 'plugin.json')}"`)
      })
    )
  )

  it.effect('fails with the import error message when the entry does not import', () =>
    run(
      Effect.gen(function* () {
        const { root } = yield* pluginDirectory(
          JSON.stringify({ name: 'chat', api: '1', host: 'host.ts' })
        )
        const { importer } = recordingImporter(() => Promise.reject(new Error('Unexpected token')))
        const loader = yield* makeHostPluginLoader(importer)

        const failure = yield* Effect.flip(
          loader.load(root).pipe(Effect.flatMap((loaded) => loaded.resolveSetup))
        )

        assert.include(failure.message, 'Unexpected token')
      })
    )
  )

  it.effect('fails when the default export is not a function', () =>
    run(
      Effect.gen(function* () {
        const { root } = yield* pluginDirectory(
          JSON.stringify({ name: 'chat', api: '1', host: 'host.ts' })
        )
        const { importer } = recordingImporter(() => Promise.resolve({ default: 'nope' }))
        const loader = yield* makeHostPluginLoader(importer)

        const failure = yield* Effect.flip(
          loader.load(root).pipe(Effect.flatMap((loaded) => loaded.resolveSetup))
        )

        assert.include(failure.message, 'must export a setup function as its default export')
      })
    )
  )
})

import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { PluginRestartRequiredError } from '@shared/plugin/plugin-registry'
import { Effect, FileSystem, Layer, Option, Path } from 'effect'
import { makeHostPluginLoader } from './plugin-loader'
import type { PluginModules } from './plugin-modules'

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const pluginDirectory = (manifest: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped()
    if (manifest !== undefined) yield* fs.writeFileString(path.join(root, 'plugin.json'), manifest)
    return { root, path }
  })

const recordingModules = (result: () => Promise<unknown>) => {
  const calls: Array<{ root: string; entry: string }> = []
  const transactions: Array<string> = []
  const modules: PluginModules = {
    transact: (root, use) =>
      Effect.sync(() => void transactions.push(root)).pipe(Effect.andThen(use)),
    importEntry: (root, entry) => {
      calls.push({ root, entry })
      return result()
    }
  }
  return { modules, calls, transactions }
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
        const { modules, calls } = recordingModules(() => Promise.resolve({ default: setup }))
        const loader = yield* makeHostPluginLoader(modules)

        const loaded = yield* loader.load(root, Effect.succeed)
        const importedBeforeResolve = calls.length
        const resolved = yield* loaded.resolveSetup

        assert.deepStrictEqual(loaded.manifest, { name: 'chat', api: '1', host: 'src/host.ts' })
        assert.strictEqual(importedBeforeResolve, 0)
        assert.strictEqual(Option.getOrThrow(resolved), setup)
        assert.deepStrictEqual(calls, [{ root, entry: path.join(root, 'src', 'host.ts') }])
      })
    )
  )

  it.effect(
    'peeks at the manifest, including its load mode, without importing or transacting',
    () =>
      run(
        Effect.gen(function* () {
          const { root } = yield* pluginDirectory(
            JSON.stringify({ name: 'chat', api: '1', host: 'host.ts', load: 'eager' })
          )
          const { modules, calls, transactions } = recordingModules(() => Promise.resolve({}))
          const loader = yield* makeHostPluginLoader(modules)

          const manifest = yield* loader.peek(root)

          assert.deepStrictEqual(manifest, {
            name: 'chat',
            api: '1',
            host: 'host.ts',
            load: 'eager'
          })
          assert.deepStrictEqual(calls, [])
          assert.deepStrictEqual(transactions, [])
        })
      )
  )

  it.effect('refuses a load mode other than eager or lazy when peeking', () =>
    run(
      Effect.gen(function* () {
        const { root } = yield* pluginDirectory(
          JSON.stringify({ name: 'chat', api: '1', load: 'sometimes' })
        )
        const { modules } = recordingModules(() => Promise.resolve({}))
        const loader = yield* makeHostPluginLoader(modules)

        const error = yield* Effect.flip(loader.peek(root))

        assert.strictEqual(error._tag, 'PluginLoadError')
        assert.include(error.message, 'plugin.json')
      })
    )
  )

  it.effect('fails a peek when plugin.json is missing', () =>
    run(
      Effect.gen(function* () {
        const { root } = yield* pluginDirectory(undefined)
        const { modules } = recordingModules(() => Promise.resolve({}))
        const loader = yield* makeHostPluginLoader(modules)

        const error = yield* Effect.flip(loader.peek(root))

        assert.strictEqual(error._tag, 'PluginLoadError')
      })
    )
  )

  it.effect('returns no setup and imports nothing for a manifest without a host entry', () =>
    run(
      Effect.gen(function* () {
        const { root } = yield* pluginDirectory(
          JSON.stringify({ name: 'theme', api: '1', renderer: 'renderer.tsx' })
        )
        const { modules, calls } = recordingModules(() => Promise.resolve({}))
        const loader = yield* makeHostPluginLoader(modules)

        const loaded = yield* loader.load(root, Effect.succeed)
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
          recordingModules(() => Promise.resolve({})).modules
        )

        const failure = yield* Effect.flip(loader.load(root, Effect.succeed))

        assert.include(failure.message, `Cannot read "${path.join(root, 'plugin.json')}"`)
      })
    )
  )

  it.effect('fails when plugin.json is not a valid manifest', () =>
    run(
      Effect.gen(function* () {
        const { root, path } = yield* pluginDirectory(JSON.stringify({ name: 'Not Valid', api: 1 }))
        const loader = yield* makeHostPluginLoader(
          recordingModules(() => Promise.resolve({})).modules
        )

        const failure = yield* Effect.flip(loader.load(root, Effect.succeed))

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
        const { modules } = recordingModules(() => Promise.reject(new Error('Unexpected token')))
        const loader = yield* makeHostPluginLoader(modules)

        const failure = yield* Effect.flip(loader.load(root, (loaded) => loaded.resolveSetup))

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
        const { modules } = recordingModules(() => Promise.resolve({ default: 'nope' }))
        const loader = yield* makeHostPluginLoader(modules)

        const failure = yield* Effect.flip(loader.load(root, (loaded) => loaded.resolveSetup))

        assert.include(failure.message, 'must export a setup function as its default export')
      })
    )
  )

  it.effect('runs the caller inside a module transaction for the plugin root', () =>
    run(
      Effect.gen(function* () {
        const { root } = yield* pluginDirectory(
          JSON.stringify({ name: 'chat', api: '1', host: 'host.ts' })
        )
        const { modules, transactions } = recordingModules(() => Promise.resolve({}))
        const loader = yield* makeHostPluginLoader(modules)
        const seen: Array<ReadonlyArray<string>> = []

        yield* loader.load(root, () => Effect.sync(() => void seen.push([...transactions])))

        assert.deepStrictEqual(transactions, [root])
        assert.deepStrictEqual(seen, [[root]])
      })
    )
  )

  it.effect('does not run the caller when the module transaction refuses the load', () =>
    run(
      Effect.gen(function* () {
        const { root } = yield* pluginDirectory(
          JSON.stringify({ name: 'chat', api: '1', host: 'host.ts' })
        )
        const modules: PluginModules = {
          transact: () =>
            Effect.fail(new PluginRestartRequiredError({ reason: 'dependency', message: 'stale' })),
          importEntry: () => Promise.resolve({})
        }
        const loader = yield* makeHostPluginLoader(modules)
        let ran = false

        const failure = yield* Effect.flip(
          loader.load(root, () =>
            Effect.sync(() => {
              ran = true
            })
          )
        )

        assert.strictEqual(failure._tag, 'PluginRestartRequiredError')
        assert.isFalse(ran)
      })
    )
  )
})

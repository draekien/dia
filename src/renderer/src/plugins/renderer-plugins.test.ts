import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { makeRendererPlugins } from './renderer-plugins'

const manifest = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  api: '1',
  category: 'feature',
  renderer: 'renderer.tsx',
  ...extra
})

const recordingEntry = (name: string, log: Array<string>) => () =>
  Promise.resolve({
    default: () =>
      Effect.gen(function* () {
        log.push(`${name}:open`)
        yield* Effect.addFinalizer(() => Effect.sync(() => void log.push(`${name}:close`)))
      })
  })

describe('renderer plugins', () => {
  it.effect('opens a renderer entry on load and closes its scope on unload', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const plugins = yield* makeRendererPlugins({
        manifests: { sidebar: manifest('sidebar') },
        entries: { sidebar: recordingEntry('sidebar', log) }
      })

      const loaded = yield* plugins.load('sidebar')
      const unloaded = yield* plugins.unload('sidebar')

      assert.deepStrictEqual(loaded.status, { _tag: 'Loaded' })
      assert.deepStrictEqual(unloaded.status, { _tag: 'Unloaded' })
      assert.deepStrictEqual(log, ['sidebar:open', 'sidebar:close'])
    }).pipe(Effect.scoped)
  )

  it.effect('reopens the entry when a loaded plugin loads again', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const plugins = yield* makeRendererPlugins({
        manifests: { sidebar: manifest('sidebar') },
        entries: { sidebar: recordingEntry('sidebar', log) }
      })

      yield* plugins.load('sidebar')
      yield* plugins.load('sidebar')

      assert.deepStrictEqual(log, ['sidebar:open', 'sidebar:close', 'sidebar:open'])
    }).pipe(Effect.scoped)
  )

  it.effect('loads a plugin that has no renderer entry without importing anything', () =>
    Effect.gen(function* () {
      const plugins = yield* makeRendererPlugins({
        manifests: {
          hostonly: { name: 'hostonly', api: '1', category: 'feature', host: 'host.ts' }
        },
        entries: {}
      })

      const loaded = yield* plugins.load('hostonly')

      assert.deepStrictEqual(loaded.status, { _tag: 'Loaded' })
    }).pipe(Effect.scoped)
  )

  it.effect('reports Failed for a plugin built for another API version', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const plugins = yield* makeRendererPlugins({
        manifests: { sidebar: manifest('sidebar', { api: '2' }) },
        entries: { sidebar: recordingEntry('sidebar', log) }
      })

      const loaded = yield* plugins.load('sidebar')

      assert.strictEqual(loaded.status._tag, 'Failed')
      assert.deepStrictEqual(log, [])
    }).pipe(Effect.scoped)
  )

  it.effect('reports Failed when the manifest is invalid or the entry was not bundled', () =>
    Effect.gen(function* () {
      const plugins = yield* makeRendererPlugins({
        manifests: { broken: { name: 'Broken Name' }, missing: manifest('missing') },
        entries: {}
      })

      const broken = yield* plugins.load('broken')
      const missing = yield* plugins.load('missing')

      assert.strictEqual(broken.status._tag, 'Failed')
      assert.deepStrictEqual(missing.status, {
        _tag: 'Failed',
        message: 'Plugin "missing" declares a renderer entry but none was bundled'
      })
    }).pipe(Effect.scoped)
  )
})

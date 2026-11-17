import { assert, describe, it } from '@effect/vitest'
import { type PluginApi, PluginStatusChanged } from '@shared/ipc/contract'
import { PLUGIN_API_VERSION, type PluginInfo, type PluginStatus } from '@shared/plugin/manifest'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect } from 'effect'
import { followHostPlugins, makeRendererPlugins } from './renderer-plugins'

const manifest = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  api: PLUGIN_API_VERSION,
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
          hostonly: {
            name: 'hostonly',
            api: PLUGIN_API_VERSION,
            category: 'feature',
            host: 'host.ts'
          }
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
        manifests: { sidebar: manifest('sidebar', { api: '2.0.0' }) },
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

const hostInfo = (name: string, status: PluginStatus): PluginInfo => ({
  name,
  category: 'feature',
  origin: 'default',
  root: `plugins/${name}`,
  status,
  memoryBytes: 0,
  provides: []
})

const fakeHost = () => {
  const statuses = new Map<string, PluginStatus>()
  const listeners = new Set<(event: PluginStatusChanged) => void>()
  let listFails = false
  const host: Pick<PluginApi, 'list' | 'onStatusChanged'> = {
    list: () => {
      if (listFails) {
        listFails = false
        return Promise.reject(new Error('host not connected'))
      }
      return Promise.resolve([...statuses].map(([name, status]) => hostInfo(name, status)))
    },
    onStatusChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const report = (name: string, tag: 'Loaded' | 'Unloaded') => {
    statuses.set(name, { _tag: tag })
    for (const listener of listeners) listener(PluginStatusChanged.make({ name }))
  }
  const failNextList = () => {
    listFails = true
  }
  return { host, report, failNextList }
}

const awaitStatus = (plugins: PluginRegistry, name: string, tag: PluginStatus['_tag']) =>
  plugins.list().pipe(
    Effect.map((all) => all.find((plugin) => plugin.name === name)?.status._tag),
    Effect.tap(() => Effect.yieldNow),
    Effect.repeat({ until: (status) => status === tag })
  )

describe('followHostPlugins', () => {
  it.effect('closes a renderer entry when the Host reports its plugin Unloaded', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const plugins = yield* makeRendererPlugins({
        manifests: { sidebar: manifest('sidebar') },
        entries: { sidebar: recordingEntry('sidebar', log) }
      })
      yield* plugins.load('sidebar')
      const { host, report } = fakeHost()
      yield* followHostPlugins(plugins, host)

      report('sidebar', 'Unloaded')
      yield* awaitStatus(plugins, 'sidebar', 'Unloaded')

      assert.deepStrictEqual(log, ['sidebar:open', 'sidebar:close'])
    }).pipe(Effect.scoped)
  )

  it.effect('opens an unloaded renderer entry when the Host reports its plugin Loaded', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const plugins = yield* makeRendererPlugins({
        manifests: { sidebar: manifest('sidebar', { load: 'manual' }) },
        entries: { sidebar: recordingEntry('sidebar', log) }
      })
      yield* plugins.start()
      const { host, report } = fakeHost()
      yield* followHostPlugins(plugins, host)

      report('sidebar', 'Loaded')
      yield* awaitStatus(plugins, 'sidebar', 'Loaded')

      assert.deepStrictEqual(log, ['sidebar:open'])
    }).pipe(Effect.scoped)
  )

  it.effect('closes a renderer entry the Host already unloaded before following began', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const plugins = yield* makeRendererPlugins({
        manifests: { sidebar: manifest('sidebar') },
        entries: { sidebar: recordingEntry('sidebar', log) }
      })
      yield* plugins.load('sidebar')
      const { host, report } = fakeHost()
      report('sidebar', 'Unloaded')

      yield* followHostPlugins(plugins, host)
      yield* awaitStatus(plugins, 'sidebar', 'Unloaded')

      assert.deepStrictEqual(log, ['sidebar:open', 'sidebar:close'])
    }).pipe(Effect.scoped)
  )

  it.effect('does not reopen a loaded renderer entry when the Host reloads its plugin', () =>
    Effect.gen(function* () {
      const log: Array<string> = []
      const plugins = yield* makeRendererPlugins({
        manifests: { sidebar: manifest('sidebar'), marker: manifest('marker') },
        entries: { sidebar: recordingEntry('sidebar', log), marker: recordingEntry('marker', []) }
      })
      yield* plugins.load('sidebar')
      const { host, report } = fakeHost()
      yield* followHostPlugins(plugins, host)

      report('sidebar', 'Loaded')
      report('marker', 'Loaded')
      yield* awaitStatus(plugins, 'marker', 'Loaded')

      assert.deepStrictEqual(log, ['sidebar:open'])
    }).pipe(Effect.scoped)
  )

  it.effect('keeps following after the Host plugin list cannot be read', () =>
    Effect.gen(function* () {
      const plugins = yield* makeRendererPlugins({
        manifests: { sidebar: manifest('sidebar') },
        entries: { sidebar: recordingEntry('sidebar', []) }
      })
      yield* plugins.load('sidebar')
      const { host, report, failNextList } = fakeHost()
      yield* followHostPlugins(plugins, host)

      failNextList()
      report('sidebar', 'Unloaded')
      yield* Effect.yieldNow
      report('sidebar', 'Unloaded')
      const status = yield* awaitStatus(plugins, 'sidebar', 'Unloaded')

      assert.strictEqual(status, 'Unloaded')
    }).pipe(Effect.scoped)
  )
})

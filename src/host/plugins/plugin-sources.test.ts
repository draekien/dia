import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import type { PluginCategory } from '@shared/plugin/manifest'
import { Effect, FileSystem, Layer, Option, Path } from 'effect'
import { SettingsStore } from '../services/settings-store'
import { makePluginSourcesLive, PluginSources } from './plugin-sources'

const memorySettings = (initial: Record<string, string> = {}) => {
  let overrides: Record<string, string> = initial
  return Layer.succeed(SettingsStore)({
    getLastDirectory: () => Effect.succeed(Option.none()),
    setLastDirectory: () => Effect.void,
    getTheme: () => Effect.succeed(Option.none()),
    setTheme: () => Effect.void,
    getSendMode: () => Effect.succeed(Option.none()),
    setSendMode: () => Effect.void,
    getTranscriptWidth: () => Effect.succeed(Option.none()),
    setTranscriptWidth: () => Effect.void,
    getPluginOverrides: () => Effect.sync(() => overrides),
    setPluginOverride: (name, path) =>
      Effect.sync(() => {
        overrides = { ...overrides, [name]: path }
      }),
    clearPluginOverride: (name) =>
      Effect.sync(() => {
        const { [name]: _removed, ...rest } = overrides
        overrides = rest
      })
  })
}

const manifestJson = (name: string, category: PluginCategory) =>
  JSON.stringify({ name, api: '1', category, host: 'host.ts' })

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = yield* fs.makeTempDirectoryScoped()
  const writePlugin = (directory: string, name: string, category: PluginCategory = 'feature') =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(path.join(directory, 'plugin.json'), manifestJson(name, category))
    })
  const writeModulePackage = (directory: string, type: string | undefined) =>
    fs.writeFileString(
      path.join(directory, 'package.json'),
      JSON.stringify(type === undefined ? {} : { type })
    )
  const defaultRoot = path.join(base, 'shipped')
  yield* writePlugin(path.join(defaultRoot, 'chat'), 'chat')
  yield* fs.makeDirectory(path.join(defaultRoot, 'not-a-plugin'), { recursive: true })
  return { base, defaultRoot, path, fs, writePlugin, writeModulePackage }
})

const sourcesLayer = (defaultRoot: string, initialOverrides: Record<string, string> = {}) =>
  Layer.provide(
    makePluginSourcesLive(defaultRoot),
    Layer.mergeAll(memorySettings(initialOverrides), NodeFileSystem.layer, NodePath.layer)
  )

const withWorkspace = <A, E>(
  body: (
    ws: Effect.Success<typeof workspace>,
    sources: PluginSources['Service']
  ) => Effect.Effect<A, E, FileSystem.FileSystem>
) =>
  Effect.gen(function* () {
    const ws = yield* workspace
    return yield* Effect.gen(function* () {
      return yield* body(ws, yield* PluginSources)
    }).pipe(Effect.provide(sourcesLayer(ws.defaultRoot)))
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))

describe('PluginSources', () => {
  it.effect(
    'lists shipped plugin directories that have a plugin.json and every override name',
    () =>
      withWorkspace((ws, sources) =>
        Effect.gen(function* () {
          const overrideDirectory = ws.path.join(ws.base, 'worktree', 'theme')
          yield* ws.writePlugin(overrideDirectory, 'theme')
          yield* ws.writeModulePackage(ws.path.join(ws.base, 'worktree'), 'module')
          yield* sources.setOverride('theme', overrideDirectory)

          const names = yield* sources.names()

          assert.deepStrictEqual([...names].sort(), ['chat', 'theme'])
        })
      )
  )

  it.effect(
    'resolves a plugin to its default copy until an override is set, and back after it is cleared',
    () =>
      withWorkspace((ws, sources) =>
        Effect.gen(function* () {
          const overrideDirectory = ws.path.join(ws.base, 'worktree', 'chat')
          yield* ws.writePlugin(overrideDirectory, 'chat')
          yield* ws.writeModulePackage(ws.path.join(ws.base, 'worktree'), 'module')

          const before = yield* sources.resolve('chat')
          yield* sources.setOverride('chat', overrideDirectory)
          const during = yield* sources.resolve('chat')
          yield* sources.clearOverride('chat')
          const after = yield* sources.resolve('chat')

          assert.deepStrictEqual(
            before,
            Option.some({ root: ws.path.join(ws.defaultRoot, 'chat'), origin: 'default' })
          )
          assert.deepStrictEqual(
            during,
            Option.some({ root: overrideDirectory, origin: 'override' })
          )
          assert.deepStrictEqual(after, before)
        })
      )
  )

  it.effect('uses the most recently set override when a plugin is overridden twice', () =>
    withWorkspace((ws, sources) =>
      Effect.gen(function* () {
        const first = ws.path.join(ws.base, 'tree-a', 'chat')
        const second = ws.path.join(ws.base, 'tree-b', 'chat')
        for (const directory of [first, second]) {
          yield* ws.writePlugin(directory, 'chat')
          yield* ws.writeModulePackage(ws.path.dirname(directory), 'module')
        }

        yield* sources.setOverride('chat', first)
        yield* sources.setOverride('chat', second)

        assert.deepStrictEqual(
          yield* sources.resolve('chat'),
          Option.some({ root: second, origin: 'override' })
        )
      })
    )
  )

  it.effect('resolves an unknown plugin to nothing', () =>
    withWorkspace((_ws, sources) =>
      Effect.gen(function* () {
        assert.isTrue(Option.isNone(yield* sources.resolve('missing')))
      })
    )
  )

  it.effect('rejects an override directory with no plugin.json and keeps the default copy', () =>
    withWorkspace((ws, sources) =>
      Effect.gen(function* () {
        const empty = ws.path.join(ws.base, 'empty')
        yield* ws.fs.makeDirectory(empty, { recursive: true })

        const failure = yield* Effect.flip(sources.setOverride('chat', empty))

        assert.strictEqual(failure.message, `"${empty}" has no plugin.json`)
        const resolved = yield* sources.resolve('chat')
        assert.strictEqual(Option.getOrThrow(resolved).origin, 'default')
      })
    )
  )

  it.effect('rejects an override whose nearest package.json is not "type": "module"', () =>
    withWorkspace((ws, sources) =>
      Effect.gen(function* () {
        const directory = ws.path.join(ws.base, 'commonjs', 'plugins', 'chat')
        yield* ws.writePlugin(directory, 'chat')
        yield* ws.writeModulePackage(ws.path.join(ws.base, 'commonjs'), undefined)

        const failure = yield* Effect.flip(sources.setOverride('chat', directory))

        assert.strictEqual(
          failure.message,
          `"${directory}" does not resolve to a package with "type": "module"`
        )
      })
    )
  )
  it.effect('leaves out directory names and override keys that are not valid plugin names', () =>
    withWorkspace((ws, sources) =>
      Effect.gen(function* () {
        yield* ws.writePlugin(ws.path.join(ws.defaultRoot, 'Bad_Name'), 'Bad_Name')
        const overrideDirectory = ws.path.join(ws.base, 'worktree', 'theme')
        yield* ws.writePlugin(overrideDirectory, 'theme')
        yield* ws.writeModulePackage(ws.path.join(ws.base, 'worktree'), 'module')
        yield* sources.setOverride('Not Valid', overrideDirectory)

        const names = yield* sources.names()

        assert.deepStrictEqual([...names], ['chat'])
      })
    )
  )

  it.effect('stores an override as an absolute normalised path', () =>
    withWorkspace((ws, sources) =>
      Effect.gen(function* () {
        const directory = ws.path.join(ws.base, 'worktree', 'chat')
        yield* ws.writePlugin(directory, 'chat')
        yield* ws.writeModulePackage(ws.path.join(ws.base, 'worktree'), 'module')
        const untidy = ws.path.join(ws.base, 'worktree', 'elsewhere', '..', 'chat')

        yield* sources.setOverride('chat', untidy)

        assert.deepStrictEqual(
          yield* sources.resolve('chat'),
          Option.some({ root: directory, origin: 'override' })
        )
      })
    )
  )

  it.effect('rejects an override of a shipped adapter and saves nothing', () =>
    withWorkspace((ws, sources) =>
      Effect.gen(function* () {
        yield* ws.writePlugin(ws.path.join(ws.defaultRoot, 'agent'), 'agent', 'adapter')
        const directory = ws.path.join(ws.base, 'worktree', 'agent')
        yield* ws.writePlugin(directory, 'agent', 'adapter')
        yield* ws.writeModulePackage(ws.path.join(ws.base, 'worktree'), 'module')

        const result = yield* Effect.flip(sources.setOverride('agent', directory))

        assert.strictEqual(result.message, '"agent" is an adapter and cannot be overridden')
        assert.deepStrictEqual(
          yield* sources.resolve('agent'),
          Option.some({ root: ws.path.join(ws.defaultRoot, 'agent'), origin: 'default' })
        )
      })
    )
  )

  it.effect('rejects an override whose manifest declares an adapter', () =>
    withWorkspace((ws, sources) =>
      Effect.gen(function* () {
        yield* ws.writePlugin(ws.path.join(ws.defaultRoot, 'chat'), 'chat')
        const directory = ws.path.join(ws.base, 'worktree', 'chat')
        yield* ws.writePlugin(directory, 'chat', 'adapter')
        yield* ws.writeModulePackage(ws.path.join(ws.base, 'worktree'), 'module')

        const result = yield* Effect.flip(sources.setOverride('chat', directory))

        assert.strictEqual(
          result.message,
          `"${directory}" declares an adapter, and adapters load only from the shipped copy`
        )
      })
    )
  )

  it.effect('resolves a shipped adapter to its shipped copy when settings hold an override', () =>
    Effect.gen(function* () {
      const ws = yield* workspace
      yield* ws.writePlugin(ws.path.join(ws.defaultRoot, 'agent'), 'agent', 'adapter')
      const saved = ws.path.join(ws.base, 'worktree', 'agent')
      yield* ws.writePlugin(saved, 'agent')

      const resolved = yield* Effect.gen(function* () {
        return yield* (yield* PluginSources).resolve('agent')
      }).pipe(Effect.provide(sourcesLayer(ws.defaultRoot, { agent: saved })))

      assert.deepStrictEqual(
        resolved,
        Option.some({ root: ws.path.join(ws.defaultRoot, 'agent'), origin: 'default' })
      )
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
  )

  it.effect('ignores a saved override whose manifest declares an adapter', () =>
    Effect.gen(function* () {
      const ws = yield* workspace
      yield* ws.writePlugin(ws.path.join(ws.defaultRoot, 'chat'), 'chat')
      const saved = ws.path.join(ws.base, 'worktree', 'chat')
      yield* ws.writePlugin(saved, 'chat', 'adapter')

      const resolved = yield* Effect.gen(function* () {
        return yield* (yield* PluginSources).resolve('chat')
      }).pipe(Effect.provide(sourcesLayer(ws.defaultRoot, { chat: saved })))

      assert.deepStrictEqual(
        resolved,
        Option.some({ root: ws.path.join(ws.defaultRoot, 'chat'), origin: 'default' })
      )
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
  )
})

import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { ModelsLoading, ModelsReady, ModelsUnavailable } from '@shared/domain/model'
import type { ActivitySpec } from '@shared/plugin/api'
import { DateTime, Duration, Effect, Fiber, FileSystem, Layer, Option, Path, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { beforeEach, vi } from 'vitest'
import { type ClaudeInstall, NOT_INSTALLED_REASON } from './claude-install'
import {
  MODEL_PROBE_RETRY,
  MODEL_PROBE_TIMEOUT,
  type ModelProbe,
  ModelProbeFailed,
  makeModelCatalog,
  probeModels
} from './model-catalog'

const sdk = vi.hoisted(() => ({
  supportedModels: vi.fn<() => Promise<Array<Record<string, unknown>>>>(),
  close: vi.fn()
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: () => ({ supportedModels: sdk.supportedModels, close: sdk.close })
}))

const UTC_PLUS_10 = DateTime.zoneMakeOffset(Duration.toMillis(Duration.hours(10)))

const utc = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)

const NOW = utc('2026-10-25T15:00:00Z')
const READ_EARLIER_TODAY = utc('2026-10-25T14:30:00Z')
const READ_YESTERDAY_ON_THE_SAME_UTC_DAY = utc('2026-10-25T13:30:00Z')
const READ_IN_THE_FUTURE = utc('2026-10-25T16:00:00Z')
const NEXT_LOCAL_MIDNIGHT = utc('2026-10-26T14:00:00Z')

const CACHED_MODELS = [
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    description: 'Everyday tasks',
    adaptiveThinking: true,
    effortLevels: ['low', 'medium', 'high'],
    supportedFeatures: ['effort levels', 'adaptive thinking']
  }
] as const
const PROBED_MODELS = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Opus',
    adaptiveThinking: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportedFeatures: ['effort levels', 'adaptive thinking']
  },
  {
    value: 'haiku',
    displayName: 'Haiku',
    description: 'Fastest',
    adaptiveThinking: false,
    effortLevels: [],
    supportedFeatures: ['effort levels', 'adaptive thinking']
  }
] as const

const platform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  DateTime.layerCurrentZone(UTC_PLUS_10)
)

const succeeding: ModelProbe = () => Effect.succeed(PROBED_MODELS)

const failing =
  (message: string): ModelProbe =>
  () =>
    Effect.fail(new ModelProbeFailed({ message }))

const cacheJson = (fetchedAt: DateTime.Utc) =>
  JSON.stringify({ version: 2, fetchedAt: DateTime.formatIso(fetchedAt), models: CACHED_MODELS })

const openCatalog = (options: { readonly cache?: string; readonly probe?: ModelProbe }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dataDir = yield* fs.makeTempDirectoryScoped()
    const cacheFile = path.join(dataDir, 'models.json')
    if (options.cache !== undefined) yield* fs.writeFileString(cacheFile, options.cache)
    const registered: Array<ActivitySpec> = []
    const catalog = yield* makeModelCatalog(
      {
        dataDir,
        activities: {
          register: (spec) =>
            Effect.sync(() => {
              registered.push(spec)
              return { runNow: Effect.void }
            })
        }
      },
      options.probe ?? succeeding
    )
    const spec = registered[0]
    assert.isDefined(spec)
    const state = Stream.runHead(catalog.models()).pipe(Effect.map(Option.getOrThrow))
    return { spec, state, cacheFile }
  })

describe('makeModelCatalog', () => {
  it.effect('starts Loading and due now when no list is cached', () =>
    Effect.gen(function* () {
      const { spec, state } = yield* openCatalog({})

      assert.deepStrictEqual(spec.firstRunAt, NOW)
      assert.deepStrictEqual(yield* state, ModelsLoading.make({}))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('shows a list read earlier today and is next due at local midnight', () =>
    Effect.gen(function* () {
      const { spec, state } = yield* openCatalog({ cache: cacheJson(READ_EARLIER_TODAY) })

      assert.deepStrictEqual(spec.firstRunAt, NEXT_LOCAL_MIDNIGHT)
      assert.deepStrictEqual(
        yield* state,
        ModelsReady.make({
          models: CACHED_MODELS,
          fetchedAt: READ_EARLIER_TODAY,
          refreshing: false
        })
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('is due now when the list was read on an earlier local day', () =>
    Effect.gen(function* () {
      const { spec } = yield* openCatalog({
        cache: cacheJson(READ_YESTERDAY_ON_THE_SAME_UTC_DAY)
      })

      assert.deepStrictEqual(spec.firstRunAt, NOW)
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('is due now when the cached read time is in the future', () =>
    Effect.gen(function* () {
      const { spec } = yield* openCatalog({ cache: cacheJson(READ_IN_THE_FUTURE) })

      assert.deepStrictEqual(spec.firstRunAt, NOW)
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('treats an unreadable cache file as no cached list', () =>
    Effect.gen(function* () {
      const { spec, state } = yield* openCatalog({ cache: '{"version":1,' })

      assert.deepStrictEqual(spec.firstRunAt, NOW)
      assert.deepStrictEqual(yield* state, ModelsLoading.make({}))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('reads the list again when the cache predates thinking support', () =>
    Effect.gen(function* () {
      const versionOne = JSON.stringify({
        version: 1,
        fetchedAt: DateTime.formatIso(READ_EARLIER_TODAY),
        models: [{ value: 'sonnet', displayName: 'Sonnet', description: 'Everyday tasks' }]
      })
      const { spec, state } = yield* openCatalog({ cache: versionOne })

      assert.deepStrictEqual(spec.firstRunAt, NOW)
      assert.deepStrictEqual(yield* state, ModelsLoading.make({}))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('a successful run is next due at local midnight', () =>
    Effect.gen(function* () {
      const { spec } = yield* openCatalog({})

      assert.deepStrictEqual(yield* spec.run, NEXT_LOCAL_MIDNIGHT)
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('a successful run shows the probed list', () =>
    Effect.gen(function* () {
      const { spec, state } = yield* openCatalog({ cache: cacheJson(READ_EARLIER_TODAY) })

      yield* spec.run

      assert.deepStrictEqual(
        yield* state,
        ModelsReady.make({ models: PROBED_MODELS, fetchedAt: NOW, refreshing: false })
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('a successful run saves the list so the next start reads it', () =>
    Effect.gen(function* () {
      const { spec, cacheFile } = yield* openCatalog({})
      yield* spec.run
      const fs = yield* FileSystem.FileSystem

      const saved = JSON.parse(yield* fs.readFileString(cacheFile))

      assert.deepStrictEqual(saved, {
        version: 2,
        fetchedAt: '2026-10-25T15:00:00.000Z',
        models: PROBED_MODELS
      })
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('a failed run with no list shows Unavailable with the reason', () =>
    Effect.gen(function* () {
      const { spec, state } = yield* openCatalog({ probe: failing('not signed in') })

      yield* Effect.flip(spec.run)

      assert.deepStrictEqual(
        yield* state,
        ModelsUnavailable.make({ message: 'not signed in', refreshing: false })
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('a run whose probe throws shows Unavailable with the thrown message', () =>
    Effect.gen(function* () {
      const { spec, state } = yield* openCatalog({
        probe: () => Effect.die(new Error('Claude Code executable not found'))
      })

      yield* Effect.flip(spec.run)

      assert.deepStrictEqual(
        yield* state,
        ModelsUnavailable.make({ message: 'Claude Code executable not found', refreshing: false })
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('a failed run keeps the cached list and records the reason', () =>
    Effect.gen(function* () {
      const { spec, state } = yield* openCatalog({
        cache: cacheJson(READ_YESTERDAY_ON_THE_SAME_UTC_DAY),
        probe: failing('not signed in')
      })

      yield* Effect.flip(spec.run)

      assert.deepStrictEqual(
        yield* state,
        ModelsReady.make({
          models: CACHED_MODELS,
          fetchedAt: READ_YESTERDAY_ON_THE_SAME_UTC_DAY,
          refreshing: false,
          lastRefreshError: 'not signed in'
        })
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect('a failed run asks to be retried after the retry delay', () =>
    Effect.gen(function* () {
      const { spec } = yield* openCatalog({ probe: failing('not signed in') })

      const failure = yield* Effect.flip(spec.run)

      assert.deepStrictEqual(failure.message, 'not signed in')
      assert.deepStrictEqual(failure.retryAt, DateTime.addDuration(NOW, MODEL_PROBE_RETRY))
    }).pipe(Effect.scoped, Effect.provide(platform))
  )
})

const installAt = (path: Option.Option<string>): ClaudeInstall => ({
  resolve: Effect.succeed(path),
  override: Effect.succeed(Option.none()),
  setOverride: () => Effect.void
})

const installed = installAt(Option.some('/usr/local/bin/claude'))

describe('probeModels', () => {
  beforeEach(() => {
    sdk.supportedModels.mockReset()
    sdk.close.mockReset()
  })

  it.effect('fails without starting a query when no install is found', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(probeModels(installAt(Option.none()))('/data'))

      assert.strictEqual(failure.message, NOT_INSTALLED_REASON)
      assert.strictEqual(sdk.close.mock.calls.length, 0)
    })
  )

  it.effect('returns the reported models with their thinking support and closes the query', () =>
    Effect.gen(function* () {
      sdk.supportedModels.mockResolvedValue([
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          description: 'Everyday tasks',
          supportsAdaptiveThinking: true,
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
          extra: 'x'
        }
      ])

      const models = yield* probeModels(installed)('/data')

      assert.deepStrictEqual(models, [CACHED_MODELS[0]])
      assert.strictEqual(sdk.close.mock.calls.length, 1)
    })
  )

  it.effect('reports no adaptive thinking and no effort levels for a model that omits them', () =>
    Effect.gen(function* () {
      sdk.supportedModels.mockResolvedValue([
        { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: '' }
      ])

      const [model] = yield* probeModels(installed)('/data')

      assert.strictEqual(model.adaptiveThinking, false)
      assert.deepStrictEqual(model.effortLevels, [])
    })
  )

  it.effect('reports no effort levels when the SDK says the model does not support effort', () =>
    Effect.gen(function* () {
      sdk.supportedModels.mockResolvedValue([
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          description: '',
          supportsEffort: false,
          supportedEffortLevels: ['low']
        }
      ])

      const [model] = yield* probeModels(installed)('/data')

      assert.deepStrictEqual(model.effortLevels, [])
    })
  )

  it.effect('fails with the SDK error and closes the query', () =>
    Effect.gen(function* () {
      sdk.supportedModels.mockRejectedValue(new Error('spawn ENOENT'))

      const failure = yield* Effect.flip(probeModels(installed)('/data'))

      assert.strictEqual(failure.message, 'spawn ENOENT')
      assert.strictEqual(sdk.close.mock.calls.length, 1)
    })
  )

  it.effect('fails when the SDK reports no models', () =>
    Effect.gen(function* () {
      sdk.supportedModels.mockResolvedValue([])

      const failure = yield* Effect.flip(probeModels(installed)('/data'))

      assert.strictEqual(failure.message, 'Claude Code reported no models')
    })
  )

  it.effect('fails when a reported model has no value', () =>
    Effect.gen(function* () {
      sdk.supportedModels.mockResolvedValue([{ value: '', displayName: 'Sonnet', description: '' }])

      const failure = yield* Effect.flip(probeModels(installed)('/data'))

      assert.match(failure.message, /^Claude Code reported a model list dia cannot read: /)
    })
  )

  it.effect('fails and closes the query when the SDK does not answer within the timeout', () =>
    Effect.gen(function* () {
      sdk.supportedModels.mockReturnValue(Effect.runPromise(Effect.never))

      const fiber = yield* Effect.forkChild(Effect.flip(probeModels(installed)('/data')))
      yield* TestClock.adjust(MODEL_PROBE_TIMEOUT)
      const failure = yield* Fiber.join(fiber)

      assert.strictEqual(failure.message, 'Claude Code did not report models within 1m')
      assert.strictEqual(sdk.close.mock.calls.length, 1)
    })
  )
})

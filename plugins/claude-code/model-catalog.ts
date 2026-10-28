import type { ModelInfo, Query } from '@anthropic-ai/claude-agent-sdk'
import {
  ActivityRunFailed,
  type HostPluginContext,
  type ModelCatalogState,
  ModelOption,
  ModelsLoading,
  ModelsReady,
  ModelsUnavailable
} from '@dia/plugin'
import type { ModelSupportedFeature } from '@shared/domain/model'
import {
  Data,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
  type Scope,
  type Stream,
  SubscriptionRef
} from 'effect'
import { type ClaudeInstall, NOT_INSTALLED_REASON } from './claude-install'
import { messageOf, withIdleQuery } from './idle-query'

/** Longest a model probe may take before it counts as failed. */
export const MODEL_PROBE_TIMEOUT = Duration.seconds(60)

/** Delay between a failed model probe and the next one. */
export const MODEL_PROBE_RETRY = Duration.hours(1)

/** A model probe could not read the model list; `message` says why and is shown to the user. */
export class ModelProbeFailed extends Data.TaggedError('ModelProbeFailed')<{
  readonly message: string
}> {}

const ModelOptions = Schema.NonEmptyArray(ModelOption)

/** Reads the models the local Claude Code install offers, starting it in `cwd`. The list is never empty. */
export type ModelProbe = (cwd: string) => Effect.Effect<typeof ModelOptions.Type, ModelProbeFailed>

const ModelCache = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(2),
    fetchedAt: Schema.DateTimeUtcFromString,
    models: ModelOptions
  })
)
type ModelCache = typeof ModelCache.Type

const CACHE_FILE = 'models.json'

/**
 * The {@link ModelProbe} that asks the Claude Code install `install` resolves: it reads
 * `supportedModels()` from a query that starts no turn. Fails when no install is found, after
 * {@link MODEL_PROBE_TIMEOUT}, or when the reply is empty or unreadable.
 */
export const probeModels =
  (install: ClaudeInstall): ModelProbe =>
  (cwd) =>
    Effect.gen(function* () {
      const path = yield* install.resolve
      if (Option.isNone(path)) {
        return yield* new ModelProbeFailed({ message: NOT_INSTALLED_REASON })
      }
      return yield* withIdleQuery(path.value, cwd, readModels)
    })

const makeSupportedFeatures = (model: ModelInfo) => {
  const options: ModelSupportedFeature[] = []
  if (model.supportsEffort) options.push('effort levels')
  if (model.supportsAdaptiveThinking) options.push('adaptive thinking')
  if (model.supportsAutoMode) options.push('auto mode')
  if (model.supportsFastMode) options.push('fast mode')

  return options
}

const readModels = (probe: Query) =>
  Effect.tryPromise({
    try: () => probe.supportedModels(),
    catch: (cause) => new ModelProbeFailed({ message: messageOf(cause) })
  }).pipe(
    Effect.timeout(MODEL_PROBE_TIMEOUT),
    Effect.catchTag('TimeoutError', () =>
      Effect.fail(
        new ModelProbeFailed({
          message: `Claude Code did not report models within ${Duration.format(MODEL_PROBE_TIMEOUT)}`
        })
      )
    ),
    Effect.flatMap((rows) =>
      rows.length === 0
        ? Effect.fail(new ModelProbeFailed({ message: 'Claude Code reported no models' }))
        : Schema.decodeUnknownEffect(ModelOptions)(
            rows.map(
              (row) =>
                ({
                  value: row.value,
                  displayName: row.displayName,
                  description: row.description,
                  adaptiveThinking: row.supportsAdaptiveThinking === true,
                  effortLevels:
                    row.supportsEffort === true ? (row.supportedEffortLevels ?? []) : [],
                  supportedFeatures: makeSupportedFeatures(row)
                }) satisfies ModelOption
            )
          ).pipe(
            Effect.mapError(
              (issue) =>
                new ModelProbeFailed({
                  message: `Claude Code reported a model list dia cannot read: ${issue.message}`
                })
            )
          )
    )
  )

/**
 * Starts the model list of the local Claude Code install in the calling scope (the plugin's
 * setup scope) and returns it for the agent backend. The list is read by the background activity
 * `models` at start when the cached list in `<dataDir>/models.json` is missing or was read before
 * today (local time), then at each local midnight, and whenever `refreshModels` runs. A failed
 * read is retried after {@link MODEL_PROBE_RETRY}. `models` streams the current state first and
 * then every change; `refreshModels` reads the list now and completes when the read ends. Requires
 * `FileSystem` and `Path`; provide `DateTime.CurrentTimeZone` only to fix the time zone of the
 * daily rule, which otherwise follows the system zone at each read. Pass
 * {@link probeModels} as `probe` outside tests.
 */
export const makeModelCatalog = Effect.fnUntraced(function* (
  ctx: Pick<HostPluginContext, 'dataDir' | 'activities'>,
  probe: ModelProbe
): Effect.fn.Return<
  {
    readonly models: () => Stream.Stream<ModelCatalogState>
    readonly refreshModels: () => Effect.Effect<void>
  },
  never,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cacheFile = path.join(ctx.dataDir, CACHE_FILE)
  const fixedZone = yield* Effect.serviceOption(DateTime.CurrentTimeZone)
  const zone = (): DateTime.TimeZone => Option.getOrElse(fixedZone, () => DateTime.zoneMakeLocal())

  const dayStart = (now: DateTime.Utc): DateTime.Zoned =>
    DateTime.startOf(DateTime.setZone(now, zone()), 'day')

  const startOfToday = (now: DateTime.Utc): DateTime.Utc => DateTime.toUtc(dayStart(now))

  const startOfTomorrow = (now: DateTime.Utc): DateTime.Utc =>
    DateTime.toUtc(DateTime.add(dayStart(now), { days: 1 }))

  const readToday = (fetchedAt: DateTime.Utc, now: DateTime.Utc): boolean =>
    !DateTime.isLessThan(fetchedAt, startOfToday(now)) && !DateTime.isGreaterThan(fetchedAt, now)

  const cached = yield* fs.readFileString(cacheFile).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ModelCache)),
    Effect.tapError((error) =>
      error._tag === 'PlatformError' && error.reason._tag === 'NotFound'
        ? Effect.logInfo('No cached model list', { file: cacheFile })
        : Effect.logWarning('Ignored an unreadable cached model list', {
            file: cacheFile,
            error: error.message
          })
    ),
    Effect.option
  )

  const state = yield* SubscriptionRef.make<ModelCatalogState>(
    Option.match(cached, {
      onNone: () => ModelsLoading.make({}),
      onSome: (cache) =>
        ModelsReady.make({ models: cache.models, fetchedAt: cache.fetchedAt, refreshing: false })
    })
  )

  const writeCache = (cache: ModelCache) =>
    Effect.gen(function* () {
      const temporary = `${cacheFile}.tmp`
      yield* fs.writeFileString(temporary, Schema.encodeSync(ModelCache)(cache))
      yield* fs.rename(temporary, cacheFile)
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning('Could not save the model list', {
          file: cacheFile,
          error: error.message
        })
      )
    )

  const markRefreshing = SubscriptionRef.update(state, (current) => {
    switch (current._tag) {
      case 'Loading':
        return current
      case 'Unavailable':
        return ModelsUnavailable.make({ ...current, refreshing: true })
      case 'Ready':
        return ModelsReady.make({ ...current, refreshing: true })
    }
  })

  const run = Effect.gen(function* () {
    yield* markRefreshing
    const outcome = yield* Effect.result(
      probe(ctx.dataDir).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(new ModelProbeFailed({ message: messageOf(defect) }))
        )
      )
    )
    const now = yield* DateTime.now
    if (Result.isSuccess(outcome)) {
      const models = outcome.success
      yield* SubscriptionRef.set(
        state,
        ModelsReady.make({ models, fetchedAt: now, refreshing: false })
      )
      yield* writeCache({ version: 2, fetchedAt: now, models })
      yield* Effect.logInfo('Read the model list', { count: models.length })
      return startOfTomorrow(now)
    }
    const message = outcome.failure.message
    yield* SubscriptionRef.update(state, (current) =>
      current._tag === 'Ready'
        ? ModelsReady.make({ ...current, refreshing: false, lastRefreshError: message })
        : ModelsUnavailable.make({ message, refreshing: false })
    )
    return yield* new ActivityRunFailed({
      message,
      retryAt: DateTime.addDuration(now, MODEL_PROBE_RETRY)
    })
  })

  const now = yield* DateTime.now
  const firstRunAt = Option.match(cached, {
    onNone: () => now,
    onSome: (cache) => (readToday(cache.fetchedAt, now) ? startOfTomorrow(now) : now)
  })
  const handle = yield* ctx.activities.register({
    id: 'models',
    label: 'Model list',
    firstRunAt,
    run
  })

  return {
    models: () => SubscriptionRef.changes(state),
    refreshModels: () => handle.runNow
  }
})

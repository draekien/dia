import { Activity } from '@shared/domain/agent-summary'
import { Context, Data, Effect, FileSystem, Layer, Option, Result, Schema } from 'effect'

/** Each tab's last activity line, keyed by pane id. Written and read through {@link PersistenceService}. */
export const PersistedActivity = Schema.Record(Schema.String, Activity)
export type PersistedActivity = typeof PersistedActivity.Type

/** Failure raised when the activity file cannot be written to disk. Carries the target path and underlying cause. */
export class PersistenceWriteError extends Data.TaggedError('PersistenceWriteError')<{
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Service tag for persisting and restoring each tab's last activity line. The workspace is kept by
 * `WorkspaceStore`.
 * Provide it via {@link makePersistenceServiceLive}.
 */
export class PersistenceService extends Context.Service<
  PersistenceService,
  {
    /** Atomically writes every tab's last activity line. Fails with {@link PersistenceWriteError}. */
    readonly saveActivity: (
      activity: PersistedActivity
    ) => Effect.Effect<void, PersistenceWriteError>
    /** Reads the saved activity lines; empty when the file is missing, unreadable or malformed (logged). */
    readonly loadActivity: Effect.Effect<PersistedActivity>
  }
>()('PersistenceService') {}

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeActivity = Schema.decodeUnknownResult(PersistedActivity)
const encodeActivity = Schema.encodeEffect(Schema.fromJsonString(PersistedActivity))

/**
 * Builds the live {@link PersistenceService} layer, persisting activity lines at
 * `<userDataPath>/activity.json`. Requires `FileSystem.FileSystem` in the environment.
 */
export const makePersistenceServiceLive = (userDataPath: string) =>
  Layer.effect(
    PersistenceService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const activityPath = `${userDataPath}/activity.json`

      const writeAtomically = Effect.fn('PersistenceService.writeAtomically')(function* (
        filePath: string,
        serialized: string
      ) {
        const tempPath = `${filePath}.tmp`
        yield* fs
          .writeFileString(tempPath, serialized)
          .pipe(Effect.mapError((cause) => new PersistenceWriteError({ path: tempPath, cause })))
        yield* fs
          .rename(tempPath, filePath)
          .pipe(Effect.mapError((cause) => new PersistenceWriteError({ path: filePath, cause })))
      })

      const readJson = Effect.fn('PersistenceService.readJson')(function* (filePath: string) {
        const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))
        if (!exists) return Option.none<unknown>()
        const raw = yield* fs.readFileString(filePath).pipe(Effect.option)
        if (Option.isNone(raw)) {
          yield* Effect.logWarning('Failed to read file; ignoring it', { path: filePath })
          return Option.none<unknown>()
        }
        const parsed = parseJson(raw.value)
        if (Result.isFailure(parsed)) {
          yield* Effect.logWarning('File is not JSON; ignoring it', { path: filePath })
          return Option.none<unknown>()
        }
        return Option.some(parsed.success)
      })

      const saveActivity = Effect.fn('PersistenceService.saveActivity')(function* (
        activity: PersistedActivity
      ) {
        const serialized = yield* encodeActivity(activity).pipe(
          Effect.mapError((cause) => new PersistenceWriteError({ path: activityPath, cause }))
        )
        yield* writeAtomically(activityPath, serialized)
        yield* Effect.logDebug('Persisted activity', { path: activityPath })
      })

      const loadActivity = Effect.gen(function* () {
        const json = yield* readJson(activityPath)
        if (Option.isNone(json)) return {}
        const decoded = decodeActivity(json.value)
        if (Result.isFailure(decoded)) {
          yield* Effect.logWarning('Activity file is malformed; ignoring it', {
            path: activityPath
          })
          return {}
        }
        return decoded.success
      }).pipe(Effect.withSpan('PersistenceService.loadActivity'))

      return { saveActivity, loadActivity }
    })
  )

import { Activity } from '@shared/domain/agent-summary'
import { Workspace } from '@shared/domain/project'
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Result, Schema } from 'effect'
import { LegacyWorkspace, migrateLegacyWorkspace } from './workspace-migration'

/**
 * The workspace file's contents (version 2): every project with its tabs, the project order and
 * the visible tab. Written and read only through {@link PersistenceService}.
 */
export const PersistedWorkspace = Schema.Struct({
  version: Schema.Literal(2),
  workspace: Workspace
})
export type PersistedWorkspace = typeof PersistedWorkspace.Type

/** Each tab's last activity line, keyed by pane id. Written and read through {@link PersistenceService}. */
export const PersistedActivity = Schema.Record(Schema.String, Activity)
export type PersistedActivity = typeof PersistedActivity.Type

/** Failure raised when the workspace or activity file cannot be written to disk. Carries the target path and underlying cause. */
export class PersistenceWriteError extends Data.TaggedError('PersistenceWriteError')<{
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Service tag for persisting and restoring the workspace and each tab's last activity line.
 * Provide it via {@link makePersistenceServiceLive}.
 */
export class PersistenceService extends Context.Service<
  PersistenceService,
  {
    /**
     * Atomically writes the workspace to disk (temp file + rename), so a crash mid-write
     * can never leave a partially-written file. Fails with {@link PersistenceWriteError}
     * if encoding or the underlying file operations fail.
     */
    readonly saveWorkspace: (workspace: Workspace) => Effect.Effect<void, PersistenceWriteError>
    /**
     * Reads the persisted workspace. A file written before projects existed is converted to
     * projects and tabs, after a copy of it is kept as `workspace.v1.json`. Returns `None` when
     * no workspace file exists yet (first launch) and, tolerantly, also when the file is
     * unreadable or malformed; those cases are logged.
     */
    readonly loadWorkspace: Effect.Effect<Option.Option<Workspace>>
    /** Atomically writes every tab's last activity line. Fails with {@link PersistenceWriteError}. */
    readonly saveActivity: (
      activity: PersistedActivity
    ) => Effect.Effect<void, PersistenceWriteError>
    /** Reads the saved activity lines; empty when the file is missing, unreadable or malformed (logged). */
    readonly loadActivity: Effect.Effect<PersistedActivity>
  }
>()('PersistenceService') {}

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeCurrent = Schema.decodeUnknownResult(PersistedWorkspace)
const decodeLegacy = Schema.decodeUnknownResult(LegacyWorkspace)
const decodeActivity = Schema.decodeUnknownResult(PersistedActivity)
const encodeWorkspace = Schema.encodeEffect(Schema.fromJsonString(PersistedWorkspace, { space: 2 }))
const encodeActivity = Schema.encodeEffect(Schema.fromJsonString(PersistedActivity))

/**
 * Builds the live {@link PersistenceService} layer, persisting the workspace as JSON at
 * `<userDataPath>/workspace.json` and activity lines at `<userDataPath>/activity.json`. Requires
 * `FileSystem.FileSystem` and `Path.Path` in the environment.
 */
export const makePersistenceServiceLive = (userDataPath: string) =>
  Layer.effect(
    PersistenceService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspacePath = `${userDataPath}/workspace.json`
      const legacyCopyPath = `${userDataPath}/workspace.v1.json`
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

      const saveWorkspace = Effect.fn('PersistenceService.saveWorkspace')(function* (
        workspace: Workspace
      ) {
        const serialized = yield* encodeWorkspace({ version: 2, workspace }).pipe(
          Effect.mapError((cause) => new PersistenceWriteError({ path: workspacePath, cause }))
        )
        yield* writeAtomically(workspacePath, serialized)
        yield* Effect.logInfo('Persisted workspace', { path: workspacePath })
      })

      const migrate = Effect.fn('PersistenceService.migrate')(function* (legacy: LegacyWorkspace) {
        yield* fs
          .copyFile(workspacePath, legacyCopyPath)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning('Failed to keep a copy of the version 1 workspace', { cause })
            )
          )
        return yield* migrateLegacyWorkspace(legacy).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fs)
        )
      })

      const loadWorkspace = Effect.gen(function* () {
        const json = yield* readJson(workspacePath)
        if (Option.isNone(json)) return Option.none<Workspace>()
        const current = decodeCurrent(json.value)
        if (Result.isSuccess(current)) return Option.some(current.success.workspace)
        const legacy = decodeLegacy(json.value)
        if (Result.isSuccess(legacy)) return Option.some(yield* migrate(legacy.success))
        yield* Effect.logWarning('Workspace file is malformed; starting empty', {
          path: workspacePath,
          issue: current.failure
        })
        return Option.none<Workspace>()
      }).pipe(Effect.withSpan('PersistenceService.loadWorkspace'))

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

      return { saveWorkspace, loadWorkspace, saveActivity, loadActivity }
    })
  )

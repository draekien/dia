import { FileSystem } from '@effect/platform'
import { PaneConfig } from '@shared/domain/pane'
import { PaneNode } from '@shared/domain/pane-tree'
import { Context, Data, Effect, Layer, Option, Schema } from 'effect'

/**
 * A single pane's persisted entry: the config needed to restore it plus the
 * optional Agent SDK `sessionId` used to resume its live conversation. Absence
 * of `sessionId` means the pane never started a session (e.g. still pending).
 */
export const PersistedPaneEntry = Schema.Struct({
  config: PaneConfig,
  sessionId: Schema.optional(Schema.String)
})
export type PersistedPaneEntry = typeof PersistedPaneEntry.Type

/**
 * The complete persisted workspace: the pane layout `tree` and a `panes` index
 * keyed by pane id. This is the single atomic unit dia writes to disk so the
 * tree and its per-pane index can never tear apart across two writes. Consume it
 * via {@link PersistenceService.loadWorkspace} and produce it for
 * {@link PersistenceService.saveWorkspace}.
 */
export const PersistedWorkspace = Schema.Struct({
  tree: PaneNode,
  panes: Schema.Record({ key: Schema.String, value: PersistedPaneEntry })
})
export type PersistedWorkspace = typeof PersistedWorkspace.Type

/** Failure raised when the workspace file cannot be written to disk. Carries the target path and underlying cause. */
export class PersistenceWriteError extends Data.TaggedError('PersistenceWriteError')<{
  readonly path: string
  readonly cause: unknown
}> {}

/** Failure raised when the workspace file exists but cannot be read from disk. Caught internally by `loadWorkspace` and logged. */
export class PersistenceReadError extends Data.TaggedError('PersistenceReadError')<{
  readonly path: string
  readonly cause: unknown
}> {}

/** Failure raised when the workspace file's contents are not valid JSON or do not match the schema. Caught internally by `loadWorkspace` and logged. */
export class PersistenceDecodeError extends Data.TaggedError('PersistenceDecodeError')<{
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Service tag for persisting and restoring the workspace ({@link PersistedWorkspace}).
 * Depend on this to save the current layout + pane index after a layout change, or
 * to load it on startup. Provide it via {@link makePersistenceServiceLive}.
 */
export class PersistenceService extends Context.Tag('PersistenceService')<
  PersistenceService,
  {
    /**
     * Atomically writes the workspace to disk (temp file + rename), so a crash mid-write
     * can never leave a partially-written file. Fails with {@link PersistenceWriteError}
     * if encoding or the underlying file operations fail.
     */
    readonly saveWorkspace: (
      workspace: PersistedWorkspace
    ) => Effect.Effect<void, PersistenceWriteError>
    /**
     * Reads the persisted workspace. Returns `None` when no workspace file exists yet
     * (first launch) and, tolerantly, also when the file is unreadable or malformed --
     * those cases are logged (with {@link PersistenceReadError}/{@link PersistenceDecodeError})
     * so the caller can fall back to a default layout without handling an error channel.
     */
    readonly loadWorkspace: () => Effect.Effect<Option.Option<PersistedWorkspace>>
  }
>() {}

const WorkspaceJson = Schema.parseJson(PersistedWorkspace, { space: 2 })
const decodeWorkspace = Schema.decodeUnknown(WorkspaceJson)
const encodeWorkspace = Schema.encode(WorkspaceJson)

/**
 * Builds the live {@link PersistenceService} layer, persisting the workspace as JSON
 * at `<userDataPath>/workspace.json`. Requires `FileSystem.FileSystem` in the
 * environment. Provide this at the composition root wherever `PersistenceService`
 * is required.
 */
export const makePersistenceServiceLive = (userDataPath: string) =>
  Layer.effect(
    PersistenceService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const filePath = `${userDataPath}/workspace.json`
      const tempPath = `${filePath}.tmp`

      const saveWorkspace = Effect.fn('PersistenceService.saveWorkspace')(function* (
        workspace: PersistedWorkspace
      ) {
        const serialized = yield* encodeWorkspace(workspace).pipe(
          Effect.mapError((cause) => new PersistenceWriteError({ path: filePath, cause }))
        )

        yield* fs
          .writeFileString(tempPath, serialized)
          .pipe(Effect.mapError((cause) => new PersistenceWriteError({ path: tempPath, cause })))
        yield* fs
          .rename(tempPath, filePath)
          .pipe(Effect.mapError((cause) => new PersistenceWriteError({ path: filePath, cause })))

        yield* Effect.logInfo('Persisted workspace', { path: filePath })
      })

      const loadWorkspace = Effect.fn('PersistenceService.loadWorkspace')(function* () {
        const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))
        if (!exists) return Option.none<PersistedWorkspace>()

        return yield* Effect.gen(function* () {
          const raw = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((cause) => new PersistenceReadError({ path: filePath, cause })))
          const workspace = yield* decodeWorkspace(raw).pipe(
            Effect.mapError((cause) => new PersistenceDecodeError({ path: filePath, cause }))
          )
          return Option.some(workspace)
        }).pipe(
          Effect.catchTags({
            PersistenceReadError: (error) =>
              Effect.logWarning('Failed to read workspace file; falling back to default', {
                error
              }).pipe(Effect.as(Option.none<PersistedWorkspace>())),
            PersistenceDecodeError: (error) =>
              Effect.logWarning('Workspace file is malformed; falling back to default', {
                error
              }).pipe(Effect.as(Option.none<PersistedWorkspace>()))
          })
        )
      })

      return { saveWorkspace, loadWorkspace }
    })
  )

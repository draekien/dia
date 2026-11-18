import { Effect, FileSystem, Path, Schema, type Stream, SubscriptionRef } from 'effect'
import { TextGenerationSettings } from './calls'

/** What {@link TitleSettings} holds while no settings file exists or the file cannot be read. */
export const DEFAULT_TEXT_GENERATION_SETTINGS: TextGenerationSettings = {
  adapter: 'dia-claude-code',
  model: 'haiku',
  effort: 'low'
}

/** The saved {@link TextGenerationSettings}: read them, change them, and follow changes. */
export interface TitleSettings {
  /** The settings now. */
  readonly current: Effect.Effect<TextGenerationSettings>
  /** The settings now, then after each change made through {@link TitleSettings.set}. */
  readonly follow: Stream.Stream<TextGenerationSettings>
  /** Writes `settings` to the file, then publishes them to followers; a failed write is logged and nothing is published. */
  readonly set: (settings: TextGenerationSettings) => Effect.Effect<void>
}

const SettingsFile = Schema.fromJsonString(TextGenerationSettings)

const SETTINGS_FILE = 'settings.json'

/**
 * Opens the settings kept in `<dataDir>/settings.json`. A missing file reads as
 * {@link DEFAULT_TEXT_GENERATION_SETTINGS} and logs at info; an undecodable one reads the same and
 * logs a warning. Call it once per plugin entry.
 */
export const makeTitleSettings = Effect.fnUntraced(function* (
  dataDir: string
): Effect.fn.Return<TitleSettings, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(dataDir, SETTINGS_FILE)

  const read = fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettingsFile)),
    Effect.catch((error) =>
      error._tag === 'PlatformError' && error.reason._tag === 'NotFound'
        ? Effect.logInfo('No text generation settings are saved; using the defaults', {
            file
          }).pipe(Effect.as(DEFAULT_TEXT_GENERATION_SETTINGS))
        : Effect.logWarning('Ignored unreadable text generation settings', {
            file,
            error: error.message
          }).pipe(Effect.as(DEFAULT_TEXT_GENERATION_SETTINGS))
    )
  )

  const ref = yield* SubscriptionRef.make(yield* read)

  const set = (settings: TextGenerationSettings) =>
    fs.writeFileString(file, Schema.encodeSync(SettingsFile)(settings)).pipe(
      Effect.andThen(SubscriptionRef.set(ref, settings)),
      Effect.andThen(Effect.logInfo('Changed the text generation settings', settings)),
      Effect.catch((error) =>
        Effect.logError('Could not save the text generation settings', {
          file,
          error: error.message
        })
      )
    )

  return {
    current: SubscriptionRef.get(ref),
    follow: SubscriptionRef.changes(ref),
    set
  }
})

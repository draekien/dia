import { ThemePreference } from '@shared/domain/theme'
import { Context, Effect, FileSystem, Layer, Option, Result, Schema } from 'effect'

const Settings = Schema.Struct({
  lastDirectory: Schema.optional(Schema.String),
  theme: Schema.optional(ThemePreference)
})
const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeSettings = Schema.decodeUnknownResult(Settings)
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(Settings, { space: 2 }))

/**
 * Effect Context.Service for the app's persisted settings store.
 * Depend on this to read or update the user's last-opened directory and
 * colour-theme choice. Provide it via {@link makeSettingsStoreLive}.
 */
export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly getLastDirectory: () => Effect.Effect<Option.Option<string>>
    readonly setLastDirectory: (path: string) => Effect.Effect<void>
    readonly getTheme: () => Effect.Effect<Option.Option<ThemePreference>>
    readonly setTheme: (theme: ThemePreference) => Effect.Effect<void>
  }
>()('SettingsStore') {}

/**
 * Builds the live {@link SettingsStore} layer, persisting settings as JSON
 * under `<userDataPath>/settings.json`. Requires `FileSystem.FileSystem` in
 * the environment. Unreadable or malformed settings files are ignored
 * (treated as empty) rather than failing; write failures are logged, not thrown.
 */
export const makeSettingsStoreLive = (userDataPath: string) =>
  Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const filePath = `${userDataPath}/settings.json`

      const read = Effect.fn('SettingsStore.read')(function* () {
        const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))
        if (!exists) return {}

        const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => '{}'))
        const parsed = parseJson(raw)
        if (Result.isFailure(parsed)) {
          yield* Effect.logWarning('Ignoring unparseable settings file', { cause: parsed.failure })
          return {}
        }

        const decoded = decodeSettings(parsed.success)
        if (Result.isFailure(decoded)) {
          yield* Effect.logWarning('Ignoring malformed settings file', { issue: decoded.failure })
          return {}
        }
        return decoded.success
      })

      const write = Effect.fn('SettingsStore.write')(function* (settings: typeof Settings.Type) {
        yield* fs
          .writeFileString(filePath, encodeSettings(settings))
          .pipe(Effect.catch((cause) => Effect.logError('Failed to persist settings', { cause })))
      })

      const getLastDirectory = () =>
        read().pipe(Effect.map((settings) => Option.fromNullishOr(settings.lastDirectory)))

      const setLastDirectory = (path: string) =>
        read().pipe(Effect.flatMap((settings) => write({ ...settings, lastDirectory: path })))

      const getTheme = () =>
        read().pipe(Effect.map((settings) => Option.fromNullishOr(settings.theme)))

      const setTheme = (theme: ThemePreference) =>
        read().pipe(Effect.flatMap((settings) => write({ ...settings, theme })))

      return { getLastDirectory, setLastDirectory, getTheme, setTheme }
    })
  )

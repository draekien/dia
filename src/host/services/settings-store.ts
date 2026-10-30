import { SendMode } from '@shared/domain/message-queue'
import { AdapterPreferences, EMPTY_ADAPTER_PREFERENCES } from '@shared/domain/model-preferences'
import { UsageLimitResume } from '@shared/domain/parking'
import { ThemePreference } from '@shared/domain/theme'
import { TranscriptWidth } from '@shared/domain/transcript-width'
import { Context, Effect, FileSystem, Layer, Option, Result, Schema } from 'effect'

const Settings = Schema.Struct({
  theme: Schema.optional(ThemePreference),
  sendMode: Schema.optional(SendMode),
  transcriptWidth: Schema.optional(TranscriptWidth),
  usageLimitResume: Schema.optional(UsageLimitResume),
  pluginOverrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  adapters: Schema.optional(Schema.Record(Schema.String, AdapterPreferences))
})
const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeSettings = Schema.decodeUnknownResult(Settings)
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(Settings, { space: 2 }))

/**
 * Effect Context.Service for the app's persisted settings store.
 * Depend on this to read or update the user's colour-theme choice, default send mode, transcript
 * width, what dia does when a usage limit resets, per-plugin source overrides (plugin name to source directory) and per-adapter model
 * preferences (adapter plugin name to {@link AdapterPreferences}; empty when never set). Provide it via
 * {@link makeSettingsStoreLive}.
 */
export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly getTheme: () => Effect.Effect<Option.Option<ThemePreference>>
    readonly setTheme: (theme: ThemePreference) => Effect.Effect<void>
    readonly getSendMode: () => Effect.Effect<Option.Option<SendMode>>
    readonly setSendMode: (mode: SendMode) => Effect.Effect<void>
    readonly getTranscriptWidth: () => Effect.Effect<Option.Option<TranscriptWidth>>
    readonly setTranscriptWidth: (width: TranscriptWidth) => Effect.Effect<void>
    readonly getUsageLimitResume: () => Effect.Effect<Option.Option<UsageLimitResume>>
    readonly setUsageLimitResume: (mode: UsageLimitResume) => Effect.Effect<void>
    readonly getPluginOverrides: () => Effect.Effect<Readonly<Record<string, string>>>
    readonly setPluginOverride: (name: string, path: string) => Effect.Effect<void>
    readonly clearPluginOverride: (name: string) => Effect.Effect<void>
    readonly getAdapterPreferences: (adapter: string) => Effect.Effect<AdapterPreferences>
    readonly setAdapterPreferences: (
      adapter: string,
      preferences: AdapterPreferences
    ) => Effect.Effect<void>
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

      const getTheme = () =>
        read().pipe(Effect.map((settings) => Option.fromNullishOr(settings.theme)))

      const setTheme = (theme: ThemePreference) =>
        read().pipe(Effect.flatMap((settings) => write({ ...settings, theme })))

      const getSendMode = () =>
        read().pipe(Effect.map((settings) => Option.fromNullishOr(settings.sendMode)))

      const setSendMode = (sendMode: SendMode) =>
        read().pipe(Effect.flatMap((settings) => write({ ...settings, sendMode })))

      const getTranscriptWidth = () =>
        read().pipe(Effect.map((settings) => Option.fromNullishOr(settings.transcriptWidth)))

      const setTranscriptWidth = (transcriptWidth: TranscriptWidth) =>
        read().pipe(Effect.flatMap((settings) => write({ ...settings, transcriptWidth })))

      const getUsageLimitResume = () =>
        read().pipe(Effect.map((settings) => Option.fromNullishOr(settings.usageLimitResume)))

      const setUsageLimitResume = (usageLimitResume: UsageLimitResume) =>
        read().pipe(Effect.flatMap((settings) => write({ ...settings, usageLimitResume })))

      const getPluginOverrides = () =>
        read().pipe(Effect.map((settings) => settings.pluginOverrides ?? {}))

      const setPluginOverride = (name: string, path: string) =>
        read().pipe(
          Effect.flatMap((settings) =>
            write({ ...settings, pluginOverrides: { ...settings.pluginOverrides, [name]: path } })
          )
        )

      const clearPluginOverride = (name: string) =>
        read().pipe(
          Effect.flatMap((settings) => {
            const { [name]: _removed, ...rest } = settings.pluginOverrides ?? {}
            return write({ ...settings, pluginOverrides: rest })
          })
        )

      const getAdapterPreferences = (adapter: string) =>
        read().pipe(
          Effect.map((settings) => settings.adapters?.[adapter] ?? EMPTY_ADAPTER_PREFERENCES)
        )

      const setAdapterPreferences = (adapter: string, preferences: AdapterPreferences) =>
        read().pipe(
          Effect.flatMap((settings) =>
            write({ ...settings, adapters: { ...settings.adapters, [adapter]: preferences } })
          )
        )

      return {
        getTheme,
        setTheme,
        getSendMode,
        setSendMode,
        getTranscriptWidth,
        setTranscriptWidth,
        getUsageLimitResume,
        setUsageLimitResume,
        getPluginOverrides,
        setPluginOverride,
        clearPluginOverride,
        getAdapterPreferences,
        setAdapterPreferences
      }
    })
  )

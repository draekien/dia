import { ModelPreferences, Parking } from '@dia/plugin'
import { Effect, FileSystem, Option, Schema } from 'effect'
import { PREFERENCES_KEY } from './feeds'
import type { RunRows } from './run-rows'

const HANDOVER_KEY = 'settingsHandover'
const USAGE_LIMIT_RESUME_KEY = 'usageLimitResume'

const KernelSettings = Schema.fromJsonString(
  Schema.Struct({
    usageLimitResume: Schema.optional(Parking.UsageLimitResume),
    adapters: Schema.optional(Schema.Record(Schema.String, ModelPreferences.AdapterPreferences))
  })
)

/** The stored usage-limit resume mode, or the default when none is stored. */
export const usageLimitResumeOf = (rows: RunRows) =>
  rows
    .getSetting(USAGE_LIMIT_RESUME_KEY, Parking.UsageLimitResume)
    .pipe(Effect.map(Option.getOrElse(() => Parking.DEFAULT_USAGE_LIMIT_RESUME)))

/** Stores the usage-limit resume mode. */
export const storeUsageLimitResume = (rows: RunRows, mode: Parking.UsageLimitResume) =>
  rows.setSetting(USAGE_LIMIT_RESUME_KEY, Parking.UsageLimitResume, mode)

/**
 * Copies the usage-limit resume mode and the adapter's model preferences from the kernel's
 * `settings.json` at `settingsPath` once: a later call copies nothing. A missing or unreadable file
 * copies nothing and still counts as done. Takes `dia-claude-code`'s preferences, or the only
 * adapter's when it has another name.
 */
export const handOverSettings = Effect.fn('Runs.handOverSettings')(function* (
  rows: RunRows,
  settingsPath: string
) {
  if (Option.isSome(yield* rows.getSetting(HANDOVER_KEY, Schema.Boolean))) return
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(settingsPath).pipe(Effect.option)
  const settings = Option.flatMap(text, Schema.decodeUnknownOption(KernelSettings))
  if (Option.isSome(settings)) {
    const { usageLimitResume, adapters = {} } = settings.value
    if (usageLimitResume !== undefined) yield* storeUsageLimitResume(rows, usageLimitResume)
    const values = Object.values(adapters)
    const preferences = adapters['dia-claude-code'] ?? (values.length === 1 ? values[0] : undefined)
    if (preferences !== undefined) {
      yield* rows.setSetting(PREFERENCES_KEY, ModelPreferences.AdapterPreferences, preferences)
    }
    yield* Effect.logInfo('Copied run settings from settings.json', {
      usageLimitResume: usageLimitResume !== undefined,
      preferences: preferences !== undefined
    })
  } else {
    yield* Effect.logInfo('settings.json holds no run settings to copy', { settingsPath })
  }
  yield* rows.setSetting(HANDOVER_KEY, Schema.Boolean, true)
})

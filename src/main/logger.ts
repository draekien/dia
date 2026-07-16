import { FileSystem, PlatformLogger } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { NodeFileSystem } from '@effect/platform-node'
import { Clock, Duration, Effect, Layer, Logger, Option, Schema } from 'effect'

/**
 * Default log retention window, applied by {@link pruneOldLogEntries} until a
 * settings UI lets the user configure it themselves.
 */
export const DEFAULT_LOG_RETENTION = Duration.days(7)

const LOG_BATCH_WINDOW = Duration.seconds(5)

const LogLine = Schema.Struct({ timestamp: Schema.DateFromString })
const decodeLogLine = Schema.decodeUnknownOption(LogLine)

function lineTimestamp(line: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  return Option.map(decodeLogLine(parsed), (entry) => entry.timestamp.getTime()).pipe(
    Option.getOrUndefined
  )
}

/**
 * Removes entries older than `retention` from the newline-delimited JSON log
 * file at `logFilePath`. Call this before providing {@link makeLoggerLive} for
 * the same path, so pruning doesn't race with the logger's own writes.
 */
export function pruneOldLogEntries(
  logFilePath: string,
  retention: Duration.DurationInput
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(logFilePath)
    if (!exists) return

    const content = yield* fs.readFileString(logFilePath)
    const now = yield* Clock.currentTimeMillis
    const cutoff = now - Duration.toMillis(retention)
    const kept = content.split('\n').filter((line) => {
      if (line.length === 0) return false
      const timestamp = lineTimestamp(line)
      return timestamp !== undefined && timestamp >= cutoff
    })

    yield* fs.writeFileString(logFilePath, kept.length > 0 ? `${kept.join('\n')}\n` : '')
  })
}

/**
 * Builds the logger layer for a process: pretty console output in dev (no
 * console output in production), plus JSON file logging to `logFilePath` in
 * both. Provide the same `logFilePath` across the main process and any
 * forked pane-process children so their logs land in one shared file.
 */
export function makeLoggerLive(
  isDev: boolean,
  logFilePath: string
): Layer.Layer<never, PlatformError> {
  const consoleLoggerLayer = isDev ? Logger.pretty : Logger.remove(Logger.defaultLogger)
  const fileLoggerLayer = Logger.addScoped(
    Logger.jsonLogger.pipe(PlatformLogger.toFile(logFilePath, { batchWindow: LOG_BATCH_WINDOW }))
  ).pipe(Layer.provide(NodeFileSystem.layer))
  return Layer.merge(consoleLoggerLayer, fileLoggerLayer)
}

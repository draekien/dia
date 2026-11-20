import type { StartupEntry, StartupEvent, StartupLog, StartupOutcome } from '@shared/domain/startup'
import { PluginName } from '@shared/plugin/manifest'
import { Schema } from 'effect'

/** A Host step as one rendered startup line: dia's own sentence, such as `Host started`. */
export const HostStepLine = Schema.TaggedStruct('HostStep', {
  key: Schema.String,
  offsetMillis: Schema.Finite,
  text: Schema.String
})

/**
 * A plugin step as one rendered startup line: the plugin's name, what happened to it, how long its
 * load took (absent on `loading` and `skipped`), and the failure message or missing service keys.
 */
export const PluginStepLine = Schema.TaggedStruct('PluginStep', {
  key: Schema.String,
  offsetMillis: Schema.Finite,
  plugin: PluginName,
  verb: Schema.Literals(['loading', 'loaded', 'failed', 'waiting', 'restart required', 'skipped']),
  durationMillis: Schema.optional(Schema.Finite),
  detail: Schema.optional(Schema.String)
})

/** One rendered startup line; `key` is the entry's index in the log. */
export const StartupLine = Schema.Union([HostStepLine, PluginStepLine])
export type StartupLine = typeof StartupLine.Type

/**
 * What the pinned line under the startup log says. `plugin`, when present, is the eager plugin
 * startup is waiting on and follows `label`. `sinceMillis` is when the step began, in epoch
 * milliseconds; it is `undefined` before main records the first step.
 */
export interface StartupWaiting {
  readonly label: string
  readonly plugin?: string
  readonly sinceMillis: number | undefined
}

/** The rendered startup stream: its log lines, oldest first, and the pinned waiting line. */
export interface StartupDescription {
  readonly lines: ReadonlyArray<StartupLine>
  readonly waiting: StartupWaiting
}

const eagerCountText = (count: number): string => {
  if (count === 0) return 'No eager plugins'
  if (count === 1) return 'Loading 1 eager plugin'
  return `Loading ${count} eager plugins`
}

type HostStepEvent = Exclude<
  StartupEvent,
  { readonly _tag: 'EagerPluginLoadStarted' | 'EagerPluginLoadSettled' }
>

const hostStepText = (event: HostStepEvent): string => {
  switch (event._tag) {
    case 'HostStarting':
      return 'Starting the Host'
    case 'HostStarted':
      return 'Host started'
    case 'HostServicesStarting':
      return 'Starting Host services'
    case 'EagerPluginsStarting':
      return eagerCountText(event.count)
    case 'EagerPluginsSettled':
      return 'Eager plugins settled'
    case 'HostReadyReached':
      return 'Host ready'
  }
}

const settledStepOf = (outcome: StartupOutcome, durationMillis: number | undefined) => {
  const timed = durationMillis === undefined ? {} : { durationMillis }
  switch (outcome._tag) {
    case 'Loaded':
      return { verb: 'loaded', ...timed } as const
    case 'Failed':
      return { verb: 'failed', ...timed, detail: outcome.message } as const
    case 'Waiting':
      return { verb: 'waiting', ...timed, detail: `for ${outcome.missing.join(', ')}` } as const
    case 'RestartRequired':
      return { verb: 'restart required', ...timed, detail: outcome.message } as const
    case 'Skipped':
      return { verb: 'skipped' } as const
  }
}

const waitingAfter = (last: StartupEntry | undefined): StartupWaiting => {
  if (last === undefined) return { label: 'Starting dia', sinceMillis: undefined }
  const sinceMillis = last.atMillis
  switch (last.event._tag) {
    case 'HostStarting':
      return { label: 'Starting the Host', sinceMillis }
    case 'HostStarted':
    case 'HostServicesStarting':
      return { label: 'Starting Host services', sinceMillis }
    case 'EagerPluginLoadStarted':
      return { label: 'Waiting on', plugin: last.event.name, sinceMillis }
    case 'EagerPluginsStarting':
    case 'EagerPluginLoadSettled':
      return { label: 'Loading plugins', sinceMillis }
    case 'EagerPluginsSettled':
      return { label: 'Waiting for the Host', sinceMillis }
    case 'HostReadyReached':
      return { label: 'Loading the workspace', sinceMillis }
  }
}

/**
 * Turns a startup log into the lines the startup stream shows and the step it is waiting on.
 * Offsets are measured from the log's first entry, and a plugin's duration from its own
 * `loading` line. Pure: call it on every render with the latest log.
 */
export const describeStartup = (log: StartupLog): StartupDescription => {
  const originMillis = log[0]?.atMillis ?? 0
  const startedAt = new Map<string, number>()
  const lines = log.map(({ atMillis, event }, index): StartupLine => {
    const step = { key: String(index), offsetMillis: atMillis - originMillis }
    switch (event._tag) {
      case 'EagerPluginLoadStarted':
        startedAt.set(event.name, atMillis)
        return PluginStepLine.make({ ...step, plugin: event.name, verb: 'loading' })
      case 'EagerPluginLoadSettled': {
        const startedAtMillis = startedAt.get(event.name)
        const durationMillis =
          startedAtMillis === undefined ? undefined : atMillis - startedAtMillis
        return PluginStepLine.make({
          ...step,
          plugin: event.name,
          ...settledStepOf(event.outcome, durationMillis)
        })
      }
      default:
        return HostStepLine.make({ ...step, text: hostStepText(event) })
    }
  })
  return { lines, waiting: waitingAfter(log.at(-1)) }
}

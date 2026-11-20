import type { StartupEntry, StartupEvent, StartupLog } from '@shared/domain/startup'
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

const startedAtOf = (log: StartupLog, index: number, plugin: string): number | undefined => {
  for (let earlier = index - 1; earlier >= 0; earlier--) {
    const event = log[earlier].event
    if (event._tag === 'EagerPluginLoadStarted' && event.name === plugin) {
      return log[earlier].atMillis
    }
  }
  return undefined
}

const lineOf = (log: StartupLog, index: number, originMillis: number): StartupLine => {
  const { atMillis, event } = log[index]
  const key = String(index)
  const offsetMillis = atMillis - originMillis
  if (event._tag === 'EagerPluginLoadStarted') {
    return PluginStepLine.make({ key, offsetMillis, plugin: event.name, verb: 'loading' })
  }
  if (event._tag === 'EagerPluginLoadSettled') {
    const startedAt = startedAtOf(log, index, event.name)
    const durationMillis = startedAt === undefined ? undefined : atMillis - startedAt
    const base = { key, offsetMillis, plugin: event.name }
    const { outcome } = event
    switch (outcome._tag) {
      case 'Loaded':
        return PluginStepLine.make({ ...base, verb: 'loaded', durationMillis })
      case 'Failed':
        return PluginStepLine.make({
          ...base,
          verb: 'failed',
          durationMillis,
          detail: outcome.message
        })
      case 'Waiting':
        return PluginStepLine.make({
          ...base,
          verb: 'waiting',
          durationMillis,
          detail: `for ${outcome.missing.join(', ')}`
        })
      case 'RestartRequired':
        return PluginStepLine.make({
          ...base,
          verb: 'restart required',
          durationMillis,
          detail: outcome.message
        })
      case 'Skipped':
        return PluginStepLine.make({ ...base, verb: 'skipped' })
    }
  }
  return HostStepLine.make({ key, offsetMillis, text: hostStepText(event) })
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
  return {
    lines: log.map((_, index) => lineOf(log, index, originMillis)),
    waiting: waitingAfter(log.at(-1))
  }
}

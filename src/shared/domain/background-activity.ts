import { Schema } from 'effect'
import { PluginName } from '../plugin/manifest'

/** Id of a background activity, unique within the plugin that registers it: lowercase letters, digits and hyphens, starting with a letter. */
export const ActivityId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
export type ActivityId = typeof ActivityId.Type

/** The most recent run of an activity succeeded at `at`. */
export const RunSucceeded = Schema.TaggedStruct('RunSucceeded', {
  at: Schema.DateTimeUtcFromString
})
export type RunSucceeded = typeof RunSucceeded.Type

/** The most recent run of an activity failed at `at`; `message` is the reason shown to the user. */
export const RunFailed = Schema.TaggedStruct('RunFailed', {
  at: Schema.DateTimeUtcFromString,
  message: Schema.String
})
export type RunFailed = typeof RunFailed.Type

/** The outcome of an activity's most recent run: {@link RunSucceeded} or {@link RunFailed}. */
export const LastRun = Schema.Union([RunSucceeded, RunFailed])
export type LastRun = typeof LastRun.Type

/** The activity is waiting until `nextRunAt`; `lastRun` is absent before its first run. */
export const ActivityScheduled = Schema.TaggedStruct('Scheduled', {
  nextRunAt: Schema.DateTimeUtcFromString,
  lastRun: Schema.optional(LastRun)
})
export type ActivityScheduled = typeof ActivityScheduled.Type

/** A run of the activity is in progress; its next due time is known only once the run ends. */
export const ActivityRunning = Schema.TaggedStruct('Running', {
  lastRun: Schema.optional(LastRun)
})
export type ActivityRunning = typeof ActivityRunning.Type

/** State of one background activity: {@link ActivityScheduled} or {@link ActivityRunning}. */
export const ActivityStatus = Schema.Union([ActivityScheduled, ActivityRunning])
export type ActivityStatus = typeof ActivityStatus.Type

/**
 * One background activity as the Plugins page lists it: the `plugin` that registered it, its
 * `id` within that plugin, the `label` to show, and its current `status`.
 */
export const ActivityInfo = Schema.Struct({
  plugin: PluginName,
  id: ActivityId,
  label: Schema.String,
  status: ActivityStatus
})
export type ActivityInfo = typeof ActivityInfo.Type

/** Failure of `RunActivity`: no loaded plugin named `plugin` registered an activity `id`. */
export class ActivityNotFound extends Schema.TaggedError<ActivityNotFound>()('ActivityNotFound', {
  plugin: PluginName,
  id: ActivityId
}) {}

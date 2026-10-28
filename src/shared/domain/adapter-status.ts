import { Schema } from 'effect'

/** No check of the agent install has finished since the adapter started. */
export const HealthNotChecked = Schema.TaggedStruct('HealthNotChecked', {})
export type HealthNotChecked = typeof HealthNotChecked.Type

/** No agent install was found, as of `checkedAt`. Agents cannot start. */
export const HealthNotInstalled = Schema.TaggedStruct('HealthNotInstalled', {
  checkedAt: Schema.DateTimeUtcFromString
})
export type HealthNotInstalled = typeof HealthNotInstalled.Type

/**
 * The agent install cannot run: `message` says why and is shown to the user. `version` is set
 * when the install reported one; `installPath` when the failing path is known.
 */
export const HealthError = Schema.TaggedStruct('HealthError', {
  message: Schema.String,
  version: Schema.optional(Schema.String),
  installPath: Schema.optional(Schema.String),
  checkedAt: Schema.DateTimeUtcFromString
})
export type HealthError = typeof HealthError.Type

/** The install at `installPath` runs, but its sign-in could not be read: `message` says why. */
export const HealthUnknown = Schema.TaggedStruct('HealthUnknown', {
  message: Schema.String,
  version: Schema.String,
  installPath: Schema.String,
  checkedAt: Schema.DateTimeUtcFromString
})
export type HealthUnknown = typeof HealthUnknown.Type

/** The install at `installPath` runs, but no account is signed in. Agents cannot start. */
export const HealthNotSignedIn = Schema.TaggedStruct('HealthNotSignedIn', {
  version: Schema.String,
  installPath: Schema.String,
  checkedAt: Schema.DateTimeUtcFromString
})
export type HealthNotSignedIn = typeof HealthNotSignedIn.Type

/** The install at `installPath` runs and is signed in; `email` and `subscriptionType` are set when the agent reports them. */
export const HealthReady = Schema.TaggedStruct('HealthReady', {
  version: Schema.String,
  installPath: Schema.String,
  email: Schema.optional(Schema.String),
  subscriptionType: Schema.optional(Schema.String),
  checkedAt: Schema.DateTimeUtcFromString
})
export type HealthReady = typeof HealthReady.Type

/** The result of the latest check of the agent install. Switch on `_tag`. */
export const AdapterHealth = Schema.Union([
  HealthNotChecked,
  HealthNotInstalled,
  HealthError,
  HealthUnknown,
  HealthNotSignedIn,
  HealthReady
])
export type AdapterHealth = typeof AdapterHealth.Type

/**
 * The agent adapter's install status. `checking` is true while a check runs;
 * `installPathOverride` is the install path the user set, or null when the adapter finds the
 * install itself.
 */
export const AdapterStatus = Schema.Struct({
  health: AdapterHealth,
  checking: Schema.Boolean,
  installPathOverride: Schema.NullOr(Schema.NonEmptyString)
})
export type AdapterStatus = typeof AdapterStatus.Type

/**
 * An {@link AdapterStatus} as the renderer receives it from `GetAdapterStatus` and
 * `AdapterStatusChanged`. Keep the snapshot with the highest `revision` when a reply and an event
 * race; revisions rise across Host restarts.
 */
export const AdapterStatusSnapshot = Schema.Struct({
  revision: Schema.Int,
  status: AdapterStatus
})
export type AdapterStatusSnapshot = typeof AdapterStatusSnapshot.Type

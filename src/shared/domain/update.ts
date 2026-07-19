import { Schema } from 'effect'

/**
 * The app self-update lifecycle has not produced any signal yet (no check has
 * run, or one hasn't reported back). The initial status the renderer holds
 * before the main process pushes anything. Construct with `UpdateIdle.make({})`.
 */
export const UpdateIdle = Schema.TaggedStruct('UpdateIdle', {})
export type UpdateIdle = typeof UpdateIdle.Type

/**
 * A check for a newer release is in progress. Construct with
 * `UpdateChecking.make({})`.
 */
export const UpdateChecking = Schema.TaggedStruct('UpdateChecking', {})
export type UpdateChecking = typeof UpdateChecking.Type

/**
 * A check completed and the installed build is already the latest. Construct
 * with `UpdateUpToDate.make({})`.
 */
export const UpdateUpToDate = Schema.TaggedStruct('UpdateUpToDate', {})
export type UpdateUpToDate = typeof UpdateUpToDate.Type

/**
 * A newer release is downloading in the background. `percent` is the download
 * progress from 0 to 100. Construct with `UpdateDownloading.make({ percent })`.
 */
export const UpdateDownloading = Schema.TaggedStruct('UpdateDownloading', {
  percent: Schema.Number
})
export type UpdateDownloading = typeof UpdateDownloading.Type

/**
 * A newer release (`version`) has finished downloading and will install on the
 * next restart; the app should offer a "restart to update" action. Construct
 * with `UpdateReady.make({ version })`.
 */
export const UpdateReady = Schema.TaggedStruct('UpdateReady', {
  version: Schema.String
})
export type UpdateReady = typeof UpdateReady.Type

/**
 * A check or download failed. `message` describes what went wrong (e.g. the
 * update feed was unreachable); this is non-fatal and never blocks the app.
 * Construct with `UpdateError.make({ message })`.
 */
export const UpdateError = Schema.TaggedStruct('UpdateError', {
  message: Schema.String
})
export type UpdateError = typeof UpdateError.Type

/**
 * The state of the app's background self-update. Branch on `_tag` to render the
 * header indicator (downloading progress, a restart affordance when ready) and
 * the About dialog's update line. Pushed from the main process as it observes
 * the updater; seed the renderer with {@link DEFAULT_UPDATE_STATUS}.
 */
export const UpdateStatus = Schema.Union(
  UpdateIdle,
  UpdateChecking,
  UpdateUpToDate,
  UpdateDownloading,
  UpdateReady,
  UpdateError
)
export type UpdateStatus = typeof UpdateStatus.Type

/**
 * The status the renderer assumes before the main process reports anything:
 * {@link UpdateIdle}.
 */
export const DEFAULT_UPDATE_STATUS: UpdateStatus = UpdateIdle.make({})

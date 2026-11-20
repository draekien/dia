import { Schema } from 'effect'
import {
  PluginFailed,
  PluginLoaded,
  PluginName,
  PluginRestartRequired,
  PluginWaiting
} from '../plugin/manifest'

/** The kernel began loading `count` eager plugins. */
export const EagerPluginsStarting = Schema.TaggedStruct('EagerPluginsStarting', {
  count: Schema.Int
})

/** The kernel began loading eager plugin `name`. */
export const EagerPluginLoadStarted = Schema.TaggedStruct('EagerPluginLoadStarted', {
  name: PluginName
})

/**
 * Startup did not load the plugin: the user unloaded it, or asked to load it, before startup
 * reached it. A plugin the user already loaded reports its current status instead.
 */
export const StartupSkipped = Schema.TaggedStruct('Skipped', {})

/** How one eager plugin's startup load ended. */
export const StartupOutcome = Schema.Union([
  PluginLoaded,
  PluginFailed,
  PluginWaiting,
  PluginRestartRequired,
  StartupSkipped
])
export type StartupOutcome = typeof StartupOutcome.Type

/** Eager plugin `name`'s startup load ended with `outcome`. */
export const EagerPluginLoadSettled = Schema.TaggedStruct('EagerPluginLoadSettled', {
  name: PluginName,
  outcome: StartupOutcome
})

/** Every eager plugin has settled; the Host is about to report ready. */
export const EagerPluginsSettled = Schema.TaggedStruct('EagerPluginsSettled', {})

/** A step of the plugin kernel's startup: the eager count, each eager load's start and outcome, and the end. */
export const PluginStartupEvent = Schema.Union([
  EagerPluginsStarting,
  EagerPluginLoadStarted,
  EagerPluginLoadSettled,
  EagerPluginsSettled
])
export type PluginStartupEvent = typeof PluginStartupEvent.Type

/** Main forked a Host process. */
export const HostStarting = Schema.TaggedStruct('HostStarting', {})

/** The Host process announced itself to main. */
export const HostStarted = Schema.TaggedStruct('HostStarted', {})

/** Main handed the Host its settings; the Host is building its services. */
export const HostServicesStarting = Schema.TaggedStruct('HostServicesStarting', {})

/** The log entry for the Host's `Ready` message: the renderer can connect. */
export const HostReadyReached = Schema.TaggedStruct('HostReadyReached', {})

/** A startup step main records about the Host process itself. */
export const HostStartupEvent = Schema.Union([
  HostStarting,
  HostStarted,
  HostServicesStarting,
  HostReadyReached
])
export type HostStartupEvent = typeof HostStartupEvent.Type

/** One startup step, recorded by main or reported by the plugin kernel. */
export const StartupEvent = Schema.Union([
  ...HostStartupEvent.members,
  ...PluginStartupEvent.members
])
export type StartupEvent = typeof StartupEvent.Type

/** A startup step and the epoch milliseconds main recorded it at. */
export const StartupEntry = Schema.Struct({ atMillis: Schema.Finite, event: StartupEvent })
export type StartupEntry = typeof StartupEntry.Type

/**
 * The startup steps of the current Host run, oldest first. The first entry is that run's
 * {@link HostStarting}; a Host restart starts a new log.
 */
export const StartupLog = Schema.Array(StartupEntry)
export type StartupLog = typeof StartupLog.Type

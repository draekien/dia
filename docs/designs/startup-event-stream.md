# Startup event stream

Shows the user, while dia starts, each startup step as it happens and the step dia is waiting on, in place of the `Starting dia` skeleton.

Scope: module (a startup recorder in main, a kernel progress report, and one renderer component) plus seams in existing code. Brief: confirmed in chat on 2026-11-20 (implement-task Understand, get-aligned, impeccable shape). Issue: #190. Amends ADR-0027; ADR-0089 records the amendment, superseding ADR-0027's first progress tier (the `Starting dia` skeleton) and its text-only rule for plugin state in this view.

## Success criteria

1. While dia starts, the pane area lists `Starting the Host`, `Host started`, `Starting Host services`, `Loading N eager plugins` (`Loading 1 eager plugin`, `No eager plugins`), one `loading` line per eager plugin, and `Eager plugins settled` after the last, each with a `+N.NNs` offset from the first line.
2. A plugin's result appends a `loaded`, `failed` (with its message), `waiting` (with the missing service keys), `restart required` (with its message) or `skipped` line. Every one except `skipped` shows its duration. `failed` is Error Red.
3. A line pinned under the log names the step in progress and its elapsed time, for example `Waiting on dia-tools 6.2s`.
4. Lazy and manual plugins never appear in the stream.
5. After `HostReady` the log shows `Host ready` and the pinned line reads `Loading the workspace`; when the view and workspace arrive, the app replaces the stream.
6. A renderer that mounts late or reloads first shows the entries already logged, then the new ones.
7. Under reduced motion, new lines appear without animation and the pinned dot does not pulse.

## Data flow

```
PluginRegistry.start (Host kernel)        main: startHostProcess            renderer
  onStartup(PluginStartupEvent) ──────►     fork        → HostStarting
  AppWindow.reportStartup                  'Booted'    → HostStarted
  post(StartupProgress{event}) ─parentPort► Init sent   → HostServicesStarting
                                           StartupProgress → event as is
                                           'Ready'     → HostReadyReached
                                           StartupRecorder.record(event)
                                             stamps Clock time, appends,
                                             sends StartupLogChanged{log} ─CHANNEL.event─► useStartupLog()
                                           getStartupLog ◄──────────────── ipc invoke ─── (seed)
                                                                                         StartupStream
```

## Interface

### Shared schemas — `src/shared/domain/startup.ts` (new)

```ts
/** The kernel began loading `count` eager plugins. */
export const EagerPluginsStarting = Schema.TaggedStruct('EagerPluginsStarting', { count: Schema.Int })
/** The kernel began loading eager plugin `name`. */
export const EagerPluginLoadStarted = Schema.TaggedStruct('EagerPluginLoadStarted', { name: PluginName })
/** `start` did not load the plugin: the user loaded or unloaded it before `start` reached it. */
export const StartupSkipped = Schema.TaggedStruct('Skipped', {})
/** How one eager plugin's startup load ended. */
export const StartupOutcome = Schema.Union([PluginLoaded, PluginFailed, PluginWaiting, PluginRestartRequired, StartupSkipped])
/** Eager plugin `name`'s startup load ended with `outcome`. */
export const EagerPluginLoadSettled = Schema.TaggedStruct('EagerPluginLoadSettled', { name: PluginName, outcome: StartupOutcome })
/** Every eager plugin has settled; the Host is about to report ready. */
export const EagerPluginsSettled = Schema.TaggedStruct('EagerPluginsSettled', {})
/** What the kernel reports about its startup. */
export const PluginStartupEvent = Schema.Union([EagerPluginsStarting, EagerPluginLoadStarted, EagerPluginLoadSettled, EagerPluginsSettled])
export type PluginStartupEvent = typeof PluginStartupEvent.Type

/** Main forked a Host process. */
export const HostStarting = Schema.TaggedStruct('HostStarting', {})
/** The Host process announced itself (`Booted`). */
export const HostStarted = Schema.TaggedStruct('HostStarted', {})
/** Main handed the Host its `Init`; the Host is building its services. */
export const HostServicesStarting = Schema.TaggedStruct('HostServicesStarting', {})
/** The log entry for the Host's `Ready` message: the renderer can connect. */
export const HostReadyReached = Schema.TaggedStruct('HostReadyReached', {})
/** One startup step, from main or the kernel. */
export const StartupEvent = Schema.Union([HostStarting, HostStarted, HostServicesStarting, EagerPluginsStarting, EagerPluginLoadStarted, EagerPluginLoadSettled, EagerPluginsSettled, HostReadyReached])
export type StartupEvent = typeof StartupEvent.Type

/** A startup step and the epoch milliseconds main recorded it at. */
export const StartupEntry = Schema.Struct({ atMillis: Schema.Finite, event: StartupEvent })
/** The startup steps of the current Host run, oldest first; the first entry is its `HostStarting`. */
export const StartupLog = Schema.Array(StartupEntry)
export type StartupLog = typeof StartupLog.Type
```

### Kernel — `src/shared/plugin/plugin-registry.ts`

```ts
makePluginRegistry(deps: {
  ...existing,
  /** Runs for each step of `start` until it resolves: the eager list, each eager load's start and result, and the end. */
  readonly onStartup?: (event: PluginStartupEvent) => Effect.Effect<void>
})
```

`start` reports `EagerPluginsStarting` after `markAllLoading`, then loads each eager plugin with `loadEagerReporting(name)`: report `EagerPluginLoadStarted`, `const info = yield* loadNamed(name, true)`, report `EagerPluginLoadSettled` with `outcomeOf(info.status)` (`Loading` and `Unloaded` map to `Skipped`, because `loadNamed` returns the current info unchanged for a name `start` no longer queues, `plugin-registry.ts:949`). A plugin another caller loaded before `start` reached it keeps its current status, so its line shows that status with a near-zero duration: the log reports the plugin's state at that moment, not who loaded it. It reports `EagerPluginsSettled` before forking the lazy loads. Lazy loads keep `loadIfQueued`, so lazy and manual plugins produce no event. `report` runs `deps.onStartup` with its defects caught and logged as a warning, so a failing reporter cannot stop startup. The existing log lines stay.

### Host — `src/host/services/app-window.ts`, `src/host/plugins/host-plugins.ts`, `src/shared/ipc/host-process.ts`

```ts
// AppWindow gains:
/** Tells main about one step of the kernel's startup, so the window can show it. */
readonly reportStartup: (event: PluginStartupEvent) => Effect.Effect<void>

// HostToMainMessage gains:
/** One step of the kernel's startup, for main's startup log. */
export const StartupProgress = Schema.TaggedStruct('StartupProgress', { event: PluginStartupEvent })
```

`makeHostPluginsLive` passes `onStartup: appWindow.reportStartup`. The renderer's registry passes no `onStartup`.

### Main — `src/main/services/startup-recorder.ts` (new), `src/main/host-process.ts`, `src/main/ipc/window-ipc.ts`

```ts
/** Where the recorder pushes `StartupLogChanged`: the main window's `webContents`. Same shape as `UpdateEventSender`. */
export interface StartupEventSender { readonly send: (channel: string, ...args: ReadonlyArray<unknown>) => void }

/**
 * main's record of the current Host run's startup. `record` stamps `event` with `Clock` time and
 * appends it (a `HostStarting` first empties the log, so it covers one Host run), then pushes the
 * whole log to the renderer as `StartupLogChanged`. `current` reads the log for a renderer that
 * mounts after some steps were recorded.
 */
export interface StartupRecorder { readonly record: (event: StartupEvent) => Effect.Effect<void>; readonly current: Effect.Effect<StartupLog> }
/** Builds a {@link StartupRecorder} over `sender`, starting with an empty log. Build one per app run, before `startHostProcess`. */
export const makeStartupRecorder: (sender: StartupEventSender) => Effect.Effect<StartupRecorder>

// startHostProcess gains option:
readonly onStartup: (event: StartupEvent) => void
// The 'message' listener handles StartupProgress like Notify: it calls onStartup(event) and does not
// offer the message to the handshake queue (awaitMessage discards non-matching messages).
// runOnce calls onStartup(HostStarting) after the fork, onStartup(HostStarted) once Booted arrives,
// onStartup(HostServicesStarting) after posting Init, and onStartup(HostReadyReached) once Ready arrives,
// before SubscriptionRef.set(connectionRef, …), so the log ends with `Host ready` before the renderer connects or reloads.
// onStartup(HostServicesStarting) runs in the same synchronous step as child.postMessage(Init).
// main/index.ts passes (event) => Effect.runSync(recorder.record(event)); record has no suspension
// point (Clock read, Ref.update, synchronous send), so entries keep call order across the listener and runOnce.
// record logs each step at debug with its tag (and the plugin name for a plugin event), and the reset on HostStarting at info.

/** Registers the IPC handler that returns the startup log. Call once during main-process startup. */
export function wireGetStartupLog(current: Effect.Effect<StartupLog>): void
```

`CHANNEL` gains `getStartupLog`; `IpcEvent` gains `StartupLogChanged { log: StartupLog }`, encoded as `updater.ts` encodes `UpdateStatusChanged`. After a Host restart main reloads the window (`onRestarted`), and the stream shows the new run's steps only. `IpcEvent` is the event type of `GlobalEventFrame` in `DiaRpcs` (`rpc.ts:85`), so adding a member changes its shape: `PROTOCOL_VERSION` goes from `0.0.34` to `0.0.35` in `rpc.ts:47`; the tests import the constant, so none changes.

`wireGetStartupLog` encodes the log with `Schema.encodeSync(StartupLog)`, as `wireGetUpdateStatus` encodes its status. A Host that exits or times out before `Ready` records no event; the pinned line keeps its last step and counter until the restart's `HostStarting` empties the log, so the counter shows the stall.

### Preload — `src/preload/index.ts`, `DiaApi` in `src/shared/ipc/contract.ts`

```ts
/** The startup steps of the current Host run that main has recorded so far. */
getStartupLog(): Promise<StartupLog>
/** Calls `listener` with the whole log each time main records a step; returns the unsubscribe function. */
onStartupLogChanged(listener: (log: StartupLog) => void): () => void
```

Both are window-level: add `'getStartupLog'` and `'onStartupLogChanged'` to the keys `HostApi` omits in `src/preload/host-api.ts`. Preload already decodes each `CHANNEL.event` payload with `IpcEvent` and drops a malformed one with a warning; its listener now routes `UpdateStatusChanged` to the update listeners and `StartupLogChanged` to a new set of startup listeners. `getStartupLog` decodes the seed with `Schema.decodeUnknownSync(StartupLog)`, as `getUpdateStatus` does.

### Renderer — `src/renderer/src/components/startup-stream.tsx` (new), `src/renderer/src/hooks/use-startup-log.ts` (new), `src/renderer/src/lib/startup-lines.ts` (new)

```ts
/** The startup log. Subscribes before seeding; an event always wins over the seed, the seed is used only if no event has arrived, and a rejected seed is ignored (main may not have registered the handler yet). Returns `[]` until either arrives. */
export function useStartupLog(): StartupLog

/** A Host step as one rendered log line: dia's own sentence. */
export const HostStepLine = Schema.TaggedStruct('HostStep', { key: Schema.String, offsetMillis: Schema.Finite, text: Schema.String })
/** A plugin step as one rendered log line: name, verb, optional duration and detail. */
export const PluginStepLine = Schema.TaggedStruct('PluginStep', {
  key: Schema.String, offsetMillis: Schema.Finite, plugin: PluginName,
  verb: Schema.Literals(['loading', 'loaded', 'failed', 'waiting', 'restart required', 'skipped']),
  durationMillis: Schema.optional(Schema.Finite), detail: Schema.optional(Schema.String)
})
/** One rendered log line; `key` is the entry's index in the log. Build with `HostStepLine.make` / `PluginStepLine.make`. */
export const StartupLine = Schema.Union([HostStepLine, PluginStepLine])
export type StartupLine = typeof StartupLine.Type
/** What the pinned line says and since when: `label`, then `plugin` in its own mono span when startup waits on one; `sinceMillis` is `undefined` for an empty log. */
export interface StartupWaiting { readonly label: string; readonly plugin?: string; readonly sinceMillis: number | undefined }
/** Turns a startup log into its lines and the step in progress. Pure. */
export const describeStartup: (log: StartupLog) => { lines: ReadonlyArray<StartupLine>; waiting: StartupWaiting }

/** The startup event stream: the log, then the pinned waiting line. Render it in place of the pane area until the workspace loads. */
export function StartupStream(): React.ReactElement
```

Line text per event:

| Event | Line | Pinned line after it |
|---|---|---|
| (empty log) | none | `Starting dia` |
| `HostStarting` | `Starting the Host` | `Starting the Host` |
| `HostStarted` | `Host started` | `Starting Host services` |
| `HostServicesStarting` | `Starting Host services` | `Starting Host services` |
| `EagerPluginsStarting` | `Loading 4 eager plugins` (`Loading 1 eager plugin`, `No eager plugins`) | `Loading plugins` |
| `EagerPluginLoadStarted` | `dia-runs  loading` | `Waiting on dia-runs` |
| `EagerPluginLoadSettled` Loaded | `dia-runs  loaded  0.65s` | `Loading plugins` |
| ... Failed | `dia-runs  failed  0.65s` + message (Error Red verb, muted mono message, 2 lines max) | `Loading plugins` |
| ... Waiting | `dia-runs  waiting  0.65s` + `for <missing keys>` | `Loading plugins` |
| ... RestartRequired | `dia-runs  restart required  0.65s` + message | `Loading plugins` |
| ... Skipped | `dia-runs  skipped` | `Loading plugins` |
| `EagerPluginsSettled` | `Eager plugins settled` | `Waiting for the Host` |
| `HostReadyReached` | `Host ready` | `Loading the workspace` |

Offsets are measured from the log's first entry. A settled line's duration is measured from the nearest preceding `EagerPluginLoadStarted` with the same name. The pinned line's elapsed time is `max(0, useNow(Duration.millis(100)) - sinceMillis)`, shown to one decimal (`6.2s`), and is hidden while `sinceMillis` is `undefined`. Durations include `parentPort` transit and main's event-loop delay; the log is for reading, not measurement.

`TabContent` renders `<StartupStream />` where it rendered `<StartupSkeleton />`; `startup-skeleton.tsx` and its test are deleted.

## Visual

- Plugin names, missing service keys and failure messages are mono (Content-Is-Mono Rule): they are literal identifiers and verbatim text. Offsets, verbs, durations, `for` and the Host-step lines (`Starting the Host`, `Loading 4 eager plugins`, `Host ready`) are dia's own words, so sans, with figures tabular. The plugin name sits in a fixed-width column.
- The pinned line is sans, under a hairline, with a `StatusMedia fill="full"` dot classed `text-ink-muted animate-pulse-slow motion-reduce:animate-none` (the `StatusWorking` dot; half fill means a parked agent in DESIGN.md). The plugin name in it is its own mono span (`Waiting on` + `dia-tools`). The label is inside `role="status"` `aria-live="polite"`, so a screen reader announces each step change; the elapsed time is a sibling `<span aria-hidden="true">` outside the live region, because it changes ten times a second.
- A new line uses the existing `animate-stream-enter` with `motion-reduce:animate-none`. The log scrolls when taller than the pane and stays at the newest line while the user has not scrolled up.
- Error Red is used only on the `failed` verb (One Voice Rule); ADR-0089 amends ADR-0027's text-only rule for this view.
- DESIGN.md changes with this work: a `Startup stream` entry under Components, and the Error Red line names a failed plugin's verb in the startup stream.
- Docs change with this work: ADR-0089 joins the `docs/adr/README.md` index and ADR-0027's index status becomes `accepted, amended by ADR-0065, ADR-0084 and ADR-0089`; `docs/designs/lazy-plugin-startup.md` replaces its `StartupSkeleton` lines (32, 48) with `StartupStream`.

## Design Rationale

**main stamps the time, not the Host.** main records its own steps (fork, `Booted`, `Init`) anyway, so stamping every entry on receipt gives one clock for all of them.

**One log per Host run.** `HostStarting` empties the log. A crash-looping Host then cannot grow it, offsets restart at zero for each run, and plugin names do not repeat within one log.

**The kernel reports its startup, not its status changes.** `onChange` reports `PluginInfo` diffs; it cannot say which plugin `start` is loading now (every plugin is `Loading` from `markAllLoading`) or which plugins are eager. Deriving "the first eager plugin still `Loading`" from it would depend on `start` loading eager plugins one at a time (Information Hiding). `onStartup` states the concept directly.

**main pushes the whole log, not one entry.** One Host run's log holds a few dozen entries. Sending the whole log makes the renderer's merge one rule (the latest event wins over the seed) and needs no entry ids or gap detection.

**`describeStartup` is pure and separate from the component.** The line text, durations and pinned label are the logic the success criteria test; a pure function tests them without React or timers.

**`AppWindow.reportStartup`, not a new service.** `AppWindow` already is the Host's channel to main's window (`notify`), and `HostPlugins` already depends on it.

## Rejected Alternatives

**Send `HostReady`'s port and token before eager plugins load** — rejected by the user: renderer RPCs would reach the Host before eager plugins load, which breaks ADR-0027's first-session guarantee.

**A checklist that updates rows in place** — rejected by the user at shape in favour of an append-only log with a pinned waiting line.

**Showing the 10 s import/setup limit** — rejected by the user; the pinned line shows elapsed time only, so the kernel reports no import/setup phase.

## Refinement Record

### Round 1

**Applied**
- *Correctness (blocker)* — `awaitMessage('Ready')` discards every message that does not match, so `StartupProgress` would be lost; main's listener now handles it like `Notify`, and `onStartup` is a sync callback like `onNotify`.
- *Correctness / derive types from schemas (blocker)* — `StartupLogValue` and `StartupEventSender` were undefined and main's `StartupLog` collided with the schema; main's handle is `StartupRecorder`, types are derived from the schemas.
- *Correctness, POLA (major)* — a Host restart appended a second run to the log, making offsets and durations ambiguous and the log unbounded; `HostStarting` now empties the log.
- *Project rules: Content-Is-Mono (major)* — dia's own sentences were mono; Host-step lines are now sans, and DESIGN.md is updated in this work.
- *Define Errors Out of Existence (major)* — `status: PluginStatus` admitted `Loading`; the event carries `StartupOutcome` with `Skipped`.
- *Correctness (major)* — `loadIfQueued` discards the info, and a failing reporter would end `start` before the lazy fork; eager loads use `loadEagerReporting` and `report` catches defects.
- *Consistency (major)* — criterion 2 now matches the table (`restart required`, `skipped` has no duration).
- *Minor* — plural forms of the count line; durations described as for reading; `HostApi` omission located; elapsed clamped and hidden for an empty log; ADR wording; `HostReadyReached` named against `Ready`; `StartupEvent` lists its members instead of spreading `.members`.

**Rejected**
- *Unverified mount order (minor)* — the claim that `TabContent` may not be mounted before `HostReady`. `followHostPlugins` forks its reconcile loop (`renderer-plugins.ts:140-143`), and ADR-0027 records that the skeleton shows before `HostReady`; **Verify** observes it in the app.

### Round 2

**Applied**
- *Correctness, project rule on `PROTOCOL_VERSION` (major)* — `IpcEvent` is embedded in `GlobalEventFrame` (`rpc.ts:85`), so adding `StartupLogChanged` changes `DiaRpcs`; bump to `0.0.35`.
- *Correctness, accessibility (major)* — the elapsed time inside the live region would be announced ten times a second; it moves to an `aria-hidden` sibling.
- *Project rules: DESIGN.md (major)* — half fill means a parked agent and `StatusMedia` has no pulse; the dot uses the `StatusWorking` classes with full fill.
- *Project rules: Content-Is-Mono (major)* — verbs and durations are dia's own words; only plugin names, service keys and messages stay mono.
- *Minor* — preload decode wording matches `preload/index.ts`; non-`Skipped` results of an early load documented; `EagerPluginsStarting` carries `count`, the only value used; reuse `animate-stream-enter`; recorder logging; `HostReadyReached` recorded before the connection is published; criterion 1 lists `Eager plugins settled`; `atMillis` is `Schema.Finite`; ADR index and `lazy-plugin-startup.md` updates listed.

### Round 3

**Applied**
- *Project rule: construct tagged values via `.make` (major)* — `StartupLine` was a hand-declared union with `_tag` literals; it is now `HostStepLine` and `PluginStepLine` schemas, built with `.make`, and `key` is the entry's log index.
- *Minor* — no test hard-codes `PROTOCOL_VERSION`; main stays ordered by recording with `Effect.runSync` and calling `HostServicesStarting` in the same step as posting `Init`; `wireGetStartupLog` encodes, and a rejected seed is ignored; criterion 1 lists the count line's forms; a Host that stalls before `Ready` leaves the pinned counter running until the restart.

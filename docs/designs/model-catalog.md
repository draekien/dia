# Model catalog and background activities (issue #33)

Scope: layer. Spans `src/shared/plugin`, `src/host` (kernel), `plugins/claude-code` (adapter), `src/shared/ipc`, `src/preload`, and the renderer's New agent form and Plugins page.

## Name and Purpose

The New agent form lists the models the local Claude Code install supports, read from the Agent SDK and refreshed once per local day by a background activity that the claude-code adapter registers with a new kernel service.

## Modules

| Module | Location | Owns |
| --- | --- | --- |
| `PluginApiVersion` | `src/shared/plugin/manifest.ts` | the semver form of `plugin.json`'s `api` field and the compatibility rule |
| `BackgroundActivities` | `src/host/services/background-activities.ts` | the schedule, run state and run-now of every registered activity |
| Plugin data directory | `src/host/plugins/host-plugins.ts` (`extend`) | `<userData>/plugins/<name>/`, created before setup runs |
| `ModelCatalogFeed` | `src/host/services/model-catalog-feed.ts` | forwarding the backend's model state to the renderer and stamping its `revision`; `GetModels`, `RefreshModels` |
| `ModelCatalog` (adapter side) | `plugins/claude-code/model-catalog.ts` | the probe, `models.json`, the daily rule |
| Shared shapes | `src/shared/domain/background-activity.ts`, `src/shared/domain/model.ts` | what crosses the kernel/adapter and host/renderer boundaries |
| RPCs, events | `src/shared/ipc/rpc.ts`, `src/shared/ipc/contract.ts` | `GetModels`, `RefreshModels`, `ListActivities`, `RunActivity`, `ModelsChanged`, `ActivitiesChanged` |
| Preload API | `src/preload/host-api.ts`, `contract.ts` (`window.dia` interface) | `models.get`, `models.refresh`, `models.onChanged`, `activities.list`, `activities.run`, `activities.onChanged`; every value in its encoded (plain JSON) form |
| Model field | `src/renderer/src/components/pane-creation-form.tsx`, `src/renderer/src/hooks/use-model-catalog.ts` | the Select, refresh button, empty state |
| Activities sub-list | `src/renderer/src/components/plugins-page.tsx`, `src/renderer/src/hooks/use-activities.ts` | one row per activity under its plugin |
| ADR-0032 | `docs/adr/0032-background-activities-and-semver-plugin-api.md` | records this design; supersedes the API-version bullet at `ADR-0019:83` (that line is updated to point to ADR-0032) and extends the ADR-0029 adapter contract; added to `docs/adr/README.md` |

## Interface

### PluginApiVersion (`src/shared/plugin/manifest.ts`)

```ts
/** A plugin API version as plugin.json declares it: a `MAJOR.MINOR.PATCH` string such as "1.0.0". */
export const PluginApiVersion = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/))
export type PluginApiVersion = typeof PluginApiVersion.Type

/** The plugin API version this build of dia implements: 0.0.1 while dia is in development. */
export const PLUGIN_API_VERSION: PluginApiVersion

/** True when `host` satisfies npm's caret range of `plugin`: from 1.0.0, same major and plugin.minor <= host.minor; below 1.0.0, same minor; below 0.1.0, same patch. Otherwise patch is ignored. */
export const isApiCompatible: (host: string, plugin: string) => boolean
```

- `PluginManifest.api` changes from `Schema.String` (`manifest.ts:47`, `65`) to `PluginApiVersion`. `PLUGIN_API_VERSION` changes from the string `'1'` (`manifest.ts:8`). A manifest with `"api": "1"` fails manifest decoding.
- The check at `plugin-registry.ts:429` becomes `isApiCompatible(PLUGIN_API_VERSION, loaded.manifest.api)` and fails with `Plugin API version "2.0.0" is not supported; this dia implements "1.1.0"`. `isApiCompatible` returns false for a string that is not `MAJOR.MINOR.PATCH`.
- Shipped manifests all become `"0.0.1"`, the version of `PLUGIN_API_VERSION`. Every `api: '1'` fixture in `manifest.test.ts`, `plugin-registry.test.ts`, `plugin-loader.test.ts`, `host-plugins.test.ts`, `plugin-sources.test.ts`, `renderer-plugins.test.ts` becomes `'1.0.0'`; new tests cover `1.0.0` and `1.1.0` loading on `1.1.0`, and `1.2.0`, `2.0.0`, `1` being refused.

### Plugin context (`src/shared/plugin/api.ts`, `src/host/plugins/host-plugins.ts`)

```ts
export interface HostPluginContext extends PluginServices {
  readonly events: Stream.Stream<EventFrame>
  /** Absolute path of this plugin's own data directory, `<userData>/plugins/<name>`. It exists before setup runs, is kept across reloads, overrides and restarts, and is never deleted by dia. */
  readonly dataDir: string
  /** Registers background activities owned by this plugin; see PluginActivities. */
  readonly activities: PluginActivities
}
```

- `makePluginRegistry`'s `extend` (`plugin-registry.ts:189`) changes from `(services) => Context` to `(services) => Effect.Effect<Context, PluginLoadError>`. `open` runs it before `Scope.fork` (`plugin-registry.ts:377`), so a failure leaves no scope to close. A failing `extend` follows the setup-failure path: a plugin with no previous version is `Failed` with the error's message; a running plugin being reloaded keeps its previous version with `Loaded.reloadError` (`plugin-registry.ts:455-458`). The failure is logged with `Effect.logError`.
- Callers updated: `host-plugins.ts:45`, `renderer-plugins.ts:75` (`(services) => Effect.succeed(services)`), `plugin-registry.test.ts:97,244`.
- `makeHostPluginsLive(pluginApiPath, userDataPath)` requires `BackgroundActivities`, which `host-main.ts` builds from `eventHub` and provides to `hostPlugins` (`host-main.ts:74-77`). The Host's `extend` runs `FileSystem.makeDirectory(path.join(userDataPath, 'plugins', services.name), { recursive: true })` and binds `activities.register` to `services.name`.

### BackgroundActivities (kernel)

Plugin-facing:

```ts
/** Registration point for a plugin's background activities. */
export interface PluginActivities {
  /**
   * Schedules `spec` until the calling scope (the plugin's setup scope) closes. `spec.id` must
   * match ActivityId and be unused by this plugin; an invalid or duplicate id is a defect whose
   * message names the plugin and id.
   */
  readonly register: (spec: ActivitySpec) => Effect.Effect<ActivityHandle, never, Scope.Scope>
}

/** One background activity: `label` is shown on the Plugins page; `firstRunAt` in the past runs at once; `run` succeeds with when the next run is due, or fails with ActivityRunFailed. */
export interface ActivitySpec {
  readonly id: string
  readonly label: string
  readonly firstRunAt: DateTime.Utc
  readonly run: Effect.Effect<DateTime.Utc, ActivityRunFailed>
}

/** A run failed: `message` is shown on the Plugins page (truncated to 500 characters), `retryAt` is when the next run is due. */
export class ActivityRunFailed extends Data.TaggedError('ActivityRunFailed')<{ readonly message: string; readonly retryAt: DateTime.Utc }> {}

/** Returned by register. */
export interface ActivityHandle {
  /** Starts a run now and returns when it ends. Joins a run already in progress instead of starting a second. Returns normally if the activity's scope closes while waiting. */
  readonly runNow: Effect.Effect<void>
}
```

Kernel-facing:

```ts
/** Every registered activity, for the RPC handlers. Provided once in host-main.ts. */
export class BackgroundActivities extends Context.Service<BackgroundActivities, {
  /** PluginActivities.register for `plugin`; the Host's `extend` binds it to each plugin's name. */
  readonly register: (plugin: PluginName, spec: ActivitySpec) => Effect.Effect<ActivityHandle, never, Scope.Scope>
  /** Every registered activity of every loaded plugin, grouped by plugin in load order, each plugin's in registration order. */
  readonly list: Effect.Effect<ReadonlyArray<ActivityInfo>>
  /** Same as ActivityHandle.runNow. Fails with ActivityNotFound when no loaded plugin owns `id`. */
  readonly runNow: (plugin: PluginName, id: ActivityId) => Effect.Effect<void, ActivityNotFound>
}>()('BackgroundActivities') {}
```

Scheduling contract:

- The scheduler sleeps in slices of at most `ACTIVITY_RECHECK` (`Duration.minutes(5)`) and reads `Clock` after each slice, so a system suspend or clock change delays a due run by at most that.
- A run that dies (defect) is recorded as `RunFailed` with message `Unexpected error; see the log` and rescheduled after `ACTIVITY_DEFECT_RETRY` (`Duration.hours(1)`).
- The kernel imposes no timeout; each `run` bounds its own duration.
- Closing the registering scope (unload, reload, failed reload rollback, host shutdown) interrupts the activity's fiber and removes it from `list`. A `runNow` waiting on the activity returns normally.
- `BackgroundActivities` publishes `ActivitiesChanged.make({})` to `EventHub` on registration, removal and every status change.
- Logging: each run logs start, outcome and next due time at `Info` with `plugin` and `id`; a failed run at `Warning`; a defect at `Error` with its cause.
- `ACTIVITY_RECHECK` and `ACTIVITY_DEFECT_RETRY` are exported `Duration` constants with JSDoc.

### Shared shapes

`src/shared/domain/background-activity.ts`:

```ts
/** Id of an activity, unique within its plugin: lowercase letters, digits and hyphens. */
export const ActivityId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
/** A run that succeeded at `at`. */
export const RunSucceeded = Schema.TaggedStruct('RunSucceeded', { at: Schema.DateTimeUtcFromString })
/** A run that failed at `at`, with the message to show. */
export const RunFailed = Schema.TaggedStruct('RunFailed', { at: Schema.DateTimeUtcFromString, message: Schema.String })
/** The outcome of an activity's most recent run. */
export const LastRun = Schema.Union([RunSucceeded, RunFailed])
/** Waiting for `nextRunAt`. */
export const ActivityScheduled = Schema.TaggedStruct('Scheduled', { nextRunAt: Schema.DateTimeUtcFromString, lastRun: Schema.optional(LastRun) })
/** A run is in progress; the next due time is known only when it ends. */
export const ActivityRunning = Schema.TaggedStruct('Running', { lastRun: Schema.optional(LastRun) })
/** An activity's state as the Plugins page shows it. */
export const ActivityStatus = Schema.Union([ActivityScheduled, ActivityRunning])
/** One row of the Plugins page's activity list. */
export const ActivityInfo = Schema.Struct({ plugin: PluginName, id: ActivityId, label: Schema.String, status: ActivityStatus })
/** RunActivity named an activity no loaded plugin owns. */
export class ActivityNotFound extends Schema.TaggedError<ActivityNotFound>()('ActivityNotFound', { plugin: PluginName, id: ActivityId }) {}
```

`ActivityNotFound` follows `ProjectNotFoundError` (`src/shared/domain/project.ts:121`).

`src/shared/domain/model.ts`:

```ts
/** A model a new agent can use. Pass `value` unchanged as CreateTab's `model`; show `displayName`. */
export const ModelOption = Schema.Struct({ value: Schema.NonEmptyString, displayName: Schema.NonEmptyString, description: Schema.String })
/** No list is known yet; the first read is due or running. */
export const ModelsLoading = Schema.TaggedStruct('Loading', {})
/** No list is known; `message` says why the last read failed; `refreshing` is true while a new read runs. */
export const ModelsUnavailable = Schema.TaggedStruct('Unavailable', { message: Schema.String, refreshing: Schema.Boolean })
/** A non-empty list read at `fetchedAt`; `lastRefreshError` is set when the latest read failed and this list is older. */
export const ModelsReady = Schema.TaggedStruct('Ready', { models: Schema.NonEmptyArray(ModelOption), fetchedAt: Schema.DateTimeUtcFromString, refreshing: Schema.Boolean, lastRefreshError: Schema.optional(Schema.String) })
/** The model list as the adapter reports it. */
export const ModelCatalogState = Schema.Union([ModelsLoading, ModelsUnavailable, ModelsReady])
/** A ModelCatalogState as the renderer receives it from GetModels and ModelsChanged. A higher `revision` is newer, also across Host restarts. */
export const ModelCatalogSnapshot = Schema.Struct({ revision: Schema.Int, state: ModelCatalogState })
```

- Each schema above also exports `type X = typeof X.Type`. Every export in the Modules table, including `useModelCatalog`, `useActivities`, the `BackgroundActivities` and `ModelCatalogFeed` layers and the `window.dia` members, carries a JSDoc stating inputs, outputs and when to call it.
- `window.dia` returns `typeof ModelCatalogSnapshot.Encoded` and `typeof ActivityInfo.Encoded` (dates as ISO strings), because `contextBridge` drops prototypes (`src/preload/host-api.ts:82`); `DateTime.Utc` instances would arrive unusable. The renderer builds a `Date` from the string for `Intl.DateTimeFormat`.
- The event path encodes too. The preload's `dispatch` passes decoded events (`host-api.ts:122-124`) and `subscribeTo` forwards them unchanged (`host-api.ts:164-173`), so `models.onChanged(listener)` wraps `subscribeTo('ModelsChanged', …)` and calls `listener(Schema.encodeSync(ModelCatalogSnapshot)(event.snapshot))`. `models.get` encodes with the same encoder; `activities.list` with `Schema.encodeSync(Schema.Array(ActivityInfo))`.
- `src/host/plugin-api.ts` re-exports `ModelOption`, `ModelsLoading`, `ModelsUnavailable`, `ModelsReady` and `ActivityRunFailed` so the adapter imports them from `@dia/plugin`; `plugin-modules.test.ts` imports one of them through the child Node process.
- `CreateTab.model` is `Schema.String` (`src/shared/domain/project.ts:146`) and is passed to `query({ options: { model } })` unchanged (`plugins/claude-code/session.ts:443`).

### AgentBackend additions (`src/host/session/agent-backend.ts`)

```ts
export interface AgentBackend {
  // existing members unchanged
  /** The models a new session can use; emits the current state first, then every change. */
  readonly models: () => Stream.Stream<ModelCatalogState>
  /** Re-reads the model list from the agent and returns when the read ends, successful or not; the outcome arrives through `models`. */
  readonly refreshModels: () => Effect.Effect<void>
}
```

- `backendMethods` (`agent-backend.ts:138`) gains `'models'` and `'refreshModels'`; a test asserts `agentBackendProblems` reports a backend without them.
- `unavailableBackend.models` returns `Stream.make(ModelsUnavailable.make({ message: 'The claude-code adapter is not loaded', refreshing: false }))`; `refreshModels` logs a warning.

### ModelCatalogFeed (`src/host/services/model-catalog-feed.ts`)

```ts
/** The model list for the renderer. Call `start` once, after the adapter has loaded. */
export class ModelCatalogFeed extends Context.Service<ModelCatalogFeed, {
  /** Resolves the agent backend and starts forwarding its model states. Until it has run, `current` is Loading. */
  readonly start: Effect.Effect<void>
  /** The latest state received from the backend, with its revision. */
  readonly current: Effect.Effect<ModelCatalogSnapshot>
  /** Same as AgentBackend.refreshModels. */
  readonly refresh: Effect.Effect<void>
}>()('ModelCatalogFeed') {}
```

- The layer starts no background work and captures its `Scope.Scope`. `runHost` calls `start` after `HostPlugins.start()` and before `post(HostReady)` (`host-main.ts:166-167`); adapters finish loading inside `start()` (`plugin-registry.ts:126`). `GetModels` cannot arrive before `start`, because the renderer learns the port only from `HostReady`. The value held before `start` is `Loading` with revision 0.
- `start` resolves the backend with `resolveAgentBackend`, takes the first element of `backend.models()`, stamps it and sets `current` before returning, then forks the rest of the stream with `Effect.forkIn(scope)`. If the adapter failed to load, the feed holds the `unavailableBackend` state for the Host's lifetime; adapters are never reloaded (`manifest.ts:32`).
- Each state is stamped with `revision = max(previous + 1, Clock.currentTimeMillis)`, so revisions keep rising across Host restarts, kept in a `SubscriptionRef`, and published to `EventHub` as `ModelsChanged`.

### RPCs and events

```ts
Rpc.make('GetModels', { success: ModelCatalogSnapshot }),
Rpc.make('RefreshModels', {}),
Rpc.make('ListActivities', { success: Schema.Array(ActivityInfo) }),
Rpc.make('RunActivity', { payload: { plugin: PluginName, id: ActivityId }, error: ActivityNotFound }),
```

- Events `ModelsChanged { snapshot: ModelCatalogSnapshot }` and `ActivitiesChanged {}` join `IpcEvent`.
- `PROTOCOL_VERSION` (`rpc.ts`) changes from the number 8 to the semver string `'0.0.1'`; the Host accepts only a client offering exactly that version.
- The `DiaRpcs` JSDoc (`rpc.ts:86-92`) states that these four are safe to repeat and take no `commandId`; no payload field collides with a wrapper field. A test asserts `RunActivity`'s `plugin` and `id` reach the handler unchanged.
- `activities.run` resolves `undefined` on success and the encoded `ActivityNotFound` as plain data on refusal, as `registerProject` does (`host-api.ts:250-258`); it rejects only on a lost connection.
- After a reconnect the preload dispatches `ModelsChanged.make({ snapshot })` from `GetModels`, and `ActivitiesChanged.make({})` without calling `ListActivities` (the hook re-reads on that event). This runs as a separate effect from `refreshAfterReconnect`'s existing `Effect.all` (`host-api.ts:134-147`), with its own `Effect.catch` warning, so a failure here does not skip the workspace and summary dispatch.
- `PluginInfo` and `usePluginList` are unchanged. A new `useActivities()` hook, used only by `plugins-page.tsx`, calls `ListActivities` on mount and on `ActivitiesChanged`.

### Adapter model catalog (`plugins/claude-code/model-catalog.ts`)

```ts
/** Starts the daily model probe in the calling scope (the plugin's setup scope) and returns the catalog the backend exposes. */
export const makeModelCatalog: (ctx: Pick<HostPluginContext, 'dataDir' | 'activities'>) =>
  Effect.Effect<{ readonly models: () => Stream.Stream<ModelCatalogState>; readonly refreshModels: () => Effect.Effect<void> }, never, Scope.Scope>

/** How long one probe may take before it counts as failed. */
export const MODEL_PROBE_TIMEOUT = Duration.seconds(60)
/** How long after a failed probe the next one runs. */
export const MODEL_PROBE_RETRY = Duration.hours(1)
```

`host.ts` calls `makeModelCatalog(ctx)` before `ctx.provide` and passes the result to `makeClaudeCodeBackend`.

Behaviour:

1. Reads `<dataDir>/models.json` with `Schema.decodeUnknownEffect(ModelCache)`, where `ModelCache = Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), fetchedAt: Schema.DateTimeUtcFromString, models: Schema.NonEmptyArray(ModelOption) }))` is local to the adapter. A missing file is no cache; a file that fails to parse or decode is no cache and logs a `Warning`.
2. Initial state: `Ready` from the cache (`refreshing: false`), or `Loading` with no cache. A hung first probe leaves `Loading` after at most `MODEL_PROBE_TIMEOUT`.
3. Registers activity `models`, label `Model list`. `firstRunAt` is now when there is no cache or `fetchedAt` is not in today's local day (including a `fetchedAt` later than now); otherwise the start of the next local day.
4. `run`:
   - publishes `refreshing: true` on the current `Ready` or `Unavailable`; from `Loading` it publishes nothing and stays `Loading` until the probe ends;
   - runs the probe;
   - on success publishes `Ready { refreshing: false }` with no `lastRefreshError`, writes `models.json` through `models.json.tmp` and a rename (a failed write logs a `Warning` and does not fail the run), and returns the start of the next local day;
   - on failure publishes `Ready { refreshing: false, lastRefreshError }` when a list is known, else `Unavailable { message, refreshing: false }`, and fails with `ActivityRunFailed { message, retryAt: now + MODEL_PROBE_RETRY }`.
5. `refreshModels` is the handle's `runNow`.
6. Day boundaries use the `DateTime.CurrentTimeZone` service when one is provided, otherwise `DateTime.zoneMakeLocal()` read on each call, so a system time zone change applies at the next run. Tests provide `DateTime.layerCurrentZone(zone)` and use `TestClock`.

The probe (pseudo-code; the acquire step is an `Effect.gen` returning `{ input, q }`):

```ts
Effect.acquireUseRelease(
  acquire: input = openPromptInput(Queue.unbounded<SDKUserMessage>()); q = query({ prompt: input.prompts, options: { cwd: dataDir, persistSession: false, strictMcpConfig: true, ...(claudeExecutablePath !== undefined ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}) } }),
  use: Effect.tryPromise({ try: () => q.supportedModels(), catch: (cause) => new ModelProbeFailed({ message: errorMessage(cause) }) })
         .pipe(Effect.timeout(MODEL_PROBE_TIMEOUT), Effect.catchTag('TimeoutError', () => Effect.fail(new ModelProbeFailed({ message: `Claude Code did not report models within ${Duration.format(MODEL_PROBE_TIMEOUT)}` (renders `1m`) })))),
  release: input.end, then q.close()
)
```

- `model-catalog.ts` imports `openPromptInput` (`session.ts:343`, already exported) from `./session`; `session.ts` exports its private `claudeExecutablePath` (`session.ts:319`). The close sequence matches `session.ts:461-464`.
- `ModelProbeFailed` is a `Data.TaggedError` local to the adapter; a raw `catch: (cause) => cause` fails `pnpm typecheck` (`unknownInEffectCatch`).
- `persistSession: false` (`sdk.d.ts:1546`) writes no transcript. `strictMcpConfig: true` (`sdk.d.ts:1910-1919`) with no `mcpServers` starts no MCP servers.
- `settingSources` stays unset, as in sessions (`session.ts:438-459`), so the probe reads user and managed settings. It runs in `dataDir`, not a project directory, so project and local settings are not read (see Open Assumptions).
- Rows map to `ModelOption` by `value`, `displayName`, `description`. An empty result is a probe failure with message `Claude Code reported no models`.
- A test asserts `close()` runs after success, failure and timeout.

### Renderer

**Model field** (`pane-creation-form.tsx`). `useModelCatalog()` subscribes to `ModelsChanged` first, then calls `GetModels`, and keeps whichever snapshot has the higher `revision`.

| State | Renders | Create |
| --- | --- | --- |
| `Loading` | Select disabled, placeholder `Loading models…` | disabled |
| `Ready`, `refreshing: false` | Select of `displayName`s + ghost icon button | enabled |
| `Ready`, `refreshing: true` | same; icon spins (`motion-safe`) | enabled |
| `Ready` with `lastRefreshError` | Select + button; caption `Couldn't refresh · list from {date}` (`text-xs text-ink-muted`) | enabled |
| `Unavailable` | `Couldn't load models` + `Retry` button; `message` below in mono `text-xs`, `max-h-32 overflow-y-auto break-words` | disabled |
| `Unavailable`, `refreshing: true` | same; `Retry` shows a spinner | disabled |

- Default selection: `models[0].value`. Whether the SDK's first row is the intended default is unverified; the first implementation step checks the probe's output. When a refreshed list no longer contains the selected value, the selection resets to `models[0].value`.
- The Select trigger truncates a long `displayName` (`min-w-0 truncate`); the item list scrolls (existing `SelectContent` behaviour).
- The icon button has `aria-label="Refresh models"` and a tooltip. While refreshing, it and `Retry` use `aria-disabled="true"`, ignore activation and keep focus; neither is unmounted between `Unavailable` and `Unavailable { refreshing }`.
- One `role="status"` region announces `Refreshing models`, `Model list updated`, `Couldn't refresh models`, and `Model changed to {displayName}` when the selection was reset.
- Dates use `Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })` for today and `{ day: 'numeric', month: 'short' }` otherwise. Both the form and the Plugins page format through `formatWhen` (`src/renderer/src/lib/format-when.ts`).

**Plugins page** (`plugins-page.tsx`): under a plugin row with activities, a nested `ul` with one row per activity:

```
Model list   Ran 09:12 · next 26 Oct          [Run now]
Model list   Running…                         [Run now, aria-disabled]
Model list   Failed 09:12 · retries 10:12     [Run now]
             spawn claude ENOENT              ← mono, text-xs, same overflow rules as statusDetail
Model list   Not run yet · due 26 Oct         [Run now]
```

- `Run now` has `aria-label="Run {label} for {plugin}"`, calls `activities.run`, and is `aria-disabled` while the status is `Running`.
- One `role="status"` region on the page (not one per row) announces `{label} running`, `{label} finished` and `{label} failed`.
- Only `text-ink` and `text-ink-muted` are used (One Voice Rule). The header shows nothing.

## Design Rationale

**The adapter owns the probe and the cache.** ADR-0029 puts every Agent SDK import in `plugins/claude-code`. The kernel sees the list only as `ModelCatalogState` through `AgentBackend`, so it never learns that a file or a probe exists (Information Hiding).

**The form calls `RefreshModels`, not `RunActivity('claude-code', 'models')`.** The form needs fresh models, not knowledge of which plugin produces them or what its activity is called. `RunActivity` exists for the generic Plugins page only.

**`run` returns the next due time.** The plugin knows the cadence (local day) and the retry policy; the kernel knows only timers, run state and run-now, and persists nothing.

**`ModelCatalogState` is a tagged union; the feed adds the revision.** `Ready` requires a non-empty list, so "Ready with no models" cannot be represented. `revision` lets the renderer discard a `GetModels` reply older than an event it already applied, because global events are not replayed (`rpc.ts:71`). The feed stamps it from `Clock` rather than the adapter counting, so a restarted Host never publishes a lower revision than the renderer holds.

**`ActivityStatus` excludes "running and scheduled at once".** A run in progress has no `nextRunAt`; it gets one only from the run's result.

**Activities are read through `ListActivities`, not `PluginInfo`.** `PluginInfo` is built by the registry shared with the renderer (`plugin-registry.ts:228-241`), which cannot see a host-only service. A separate `ActivitiesChanged` event keeps activity runs from making every `usePluginList` caller re-read `ListPlugins`.

**`extend` becomes effectful.** Creating `dataDir` before setup needs file I/O; doing it in `extend` keeps every plugin's setup free of directory checks.

## Internal Decomposition

- **ActivityScheduler** (kernel) — one fiber per activity: sleep in slices until due, run, record `LastRun`, reschedule; run-now interrupts the sleep and joins an in-progress run.
- **ActivityRegistry** (kernel) — the map from `(plugin, id)` to scheduler and status, backing `list`, `runNow`, the duplicate-id check and the `ActivitiesChanged` publications.
- **ModelProbe** (adapter) — one `supportedModels()` call against a throwaway query; the only part that knows the SDK.
- **ModelCache** (adapter) — reads and writes `models.json`; the only part that knows the file format.
- **ModelCatalog** (adapter) — the daily rule and the published state; composes the two above.

## Rejected Alternatives

- **Kernel persists activity state.** Rejected at alignment: plugins own their own files through `dataDir`, which future plugins also need.
- **Static fallback list.** Rejected at alignment: the issue is that a static list goes out of date.
- **Header indicator.** Rejected at alignment: PRODUCT.md reserves attention signals for agent state.
- **Save `resolvedModel`.** Rejected at alignment: aliases should follow the newest model.
- **`ActivityHandle.status` stream.** Rejected in round 1: no caller; the adapter publishes its own state and the Plugins page reads `ListActivities`.
- **Activities inside `PluginInfo`, signalled by `PluginStatusChanged`.** Rejected in rounds 1–2: the shared registry cannot build it, and every `usePluginList` caller would re-read on each run.

## Open Assumptions

- Verified on 2026-10-26 (`docs/reasoning/2026-10-26-supported-models-probe.md`): `supportedModels()` on a `query()` whose prompt has not yielded resolves without starting a turn, and `close()` leaves no `claude.exe` running on Windows. The SDK's first row is `default` ("Default (recommended)"); `probeModels` leaves it out, so dia lists only named models and the first listed model is the first named one.
- With `settingSources` unset, user `SessionStart` hooks may run for the probe. Unverified.
- The list reflects user and managed settings only. A project's `.claude/settings.json` can accept or hide a model differently from the list. Accepted: the list is one per app, not per project.

## Tests named by the rounds

- `isApiCompatible`: `1.0.0`, `1.1.0` load on `1.1.0`; `1.2.0`, `2.0.0`, `1` refused. `0.0.1` loads only on `0.0.1`; `0.2.5` loads on `0.2.0`; `0.1.0` is refused on `0.2.0`.
- A failing `extend` on first load marks the plugin `Failed` and opens no scope; on reload it keeps the previous version with `reloadError`.
- `register` with a duplicate or invalid id dies with a message naming the plugin and id.
- A `ModelsChanged` frame carrying a `DateTime.Utc` reaches a `models.onChanged` listener as an ISO string and survives `structuredClone`.
- After a reconnect the preload dispatches `ModelsChanged` and `ActivitiesChanged`; a failed `GetModels` still lets the workspace and summaries dispatch.
- `ModelCatalogFeed.start` sets a stamped `current` before returning; with no adapter it holds the `unavailableBackend` state.
- A corrupt `models.json` counts as no cache and logs a warning.
- A defect in `run` is recorded as `RunFailed` and retried after `ACTIVITY_DEFECT_RETRY`.
- `ActivitiesChanged` is published on registration, removal and each status change.
- An `ActivityRunFailed.message` longer than 500 characters is truncated.
- A probe timeout fails with the `did not report models within 1m` message.
- `agentBackendProblems` reports a backend without `models` or `refreshModels`.
- `RunActivity`'s `plugin` and `id` reach the handler unchanged.
- `RefreshModels` during a run joins it; one probe runs.
- The revision after a simulated Host restart is higher than the revision before.
- The probe's `close()` runs after success, failure and timeout.
- A scheduled run fires once `TestClock` is set past its due time. (`TestClock` cannot show the `ACTIVITY_RECHECK` slicing, because a test clock jump wakes every sleeper.)
- Closing the plugin scope while `runNow` waits returns normally and removes the activity.
- `firstRunAt` for a cache from yesterday, today, and the future, in a fixed zone.
- The `claude-code` adapter importing `ModelsReady` and the other new re-exports through `@dia/plugin` is checked in the running app: `plugin-modules.test.ts` resolves `@dia/plugin` to a fixture, not to `out/main/plugin-api.js`.

## Refinement Record

### Round 1

**Applied**
- F1 *Correctness*: `api` is `Schema.String` and `PLUGIN_API_VERSION` is `'1'` (`manifest.ts:8,47,65`); listed the fixtures and manifests to update.
- F2 *Correctness*: `PluginInfo` is built in the shared registry and `PluginStatusChanged` fires only from `onChange` (`host-plugins.ts:47-53`); replaced with `ListActivities` (event changed again in round 2).
- F3 *Correctness*: `extend` is synchronous (`host-plugins.ts:45`) and lacks `userDataPath`; `extend` becomes effectful and `makeHostPluginsLive` takes `userDataPath`.
- F4 *Correctness*: `agentBackendProblems` requires functions (`agent-backend.ts:138-151`); `models`/`refreshModels` are functions and added to `backendMethods`; added `ModelCatalogFeed`.
- F5 *Project rules*: re-exports through `@dia/plugin`.
- F6 *Project rules*: ADR-0032 added to Modules.
- F7 *Project rules*: `DiaRpcs` JSDoc and the payload test.
- F8 *Correctness*: defined `ActivityNotFound` and `ActivityIdTaken`.
- F9 *Correctness*: preload API added to Modules.
- F10 *Hardening*: `revision`; subscribe before `GetModels`.
- F11 *Correctness*: `toCodecJson` for `models.json`; `Schema.optional` instead of `Schema.Option`.
- F12 *Correctness*: `DateTime.withCurrentZoneLocal` inside the adapter.
- F13 *Project rules*: JSDoc and derived types stated for every export.
- F14 *Project rules*: `PluginApiVersion` type derived from its schema; parameters renamed `host`, `plugin`.
- F15 *Hardening*: sliced sleep, closed-scope and waiter behaviour.
- F16 (part) *Hardening*: `acquireUseRelease`, `persistSession: false`, `strictMcpConfig: true`, 60 s timeout, reuse of `openPromptInput`, Windows cleanup as an open assumption.
- F17 *Hardening*: write failure does not fail the run; fixed temp name; 500-character message limit.
- F18 *Define Errors Out of Existence*: `Unavailable` gains `refreshing`.
- F19 *Accessibility*: `aria-disabled`, single status region, `Run now` labels, `Intl.DateTimeFormat`.
- F20 *Minimize Complexity*: removed `ActivityHandle.status`.
- F21 *Hardening*: removal and re-registration publish the change event.
- F22 *Names as Documentation*: `models`/`refreshModels`; `host.ts` wiring stated.
- F23 *Project rules*: logging and exported `Duration` constants.
- F24 *Correctness*: `CreateTab.model` verified at `project.ts:146`; default selection marked unverified.
- F25 *Define Errors Out of Existence*: `register` decodes `id` with `ActivityId`.

**Rejected**
- F16 (part) `settingSources: []`: sessions leave `settingSources` unset (`session.ts:438-459`); a probe without settings could list models the user's settings exclude or omit ones they add, so the probe would disagree with sessions.

### Round 2

**Applied**
- A *Correctness*: `window.dia` returns encoded values; `contextBridge` drops prototypes (`host-api.ts:82`).
- B *Correctness*: `revision` moved from the adapter to `ModelCatalogFeed`, stamped from `Clock`; `refreshAfterReconnect` re-reads models and activities.
- C *Correctness*: `ModelCatalogFeed.start` called after `HostPlugins.start()` (`host-main.ts:166`).
- D *Correctness*: `extend` runs before `Scope.fork`; listed every caller and test.
- E *Correctness*: `ListActivities` takes no payload; `useActivities` used only by the Plugins page. Changed from the proposed fix: a new `ActivitiesChanged` event instead of reusing `PluginStatusChanged`, so activity runs do not make every `usePluginList` caller re-read `ListPlugins`.
- F *Correctness*: `openPromptInput` takes a queue (`session.ts:343`); `claudeExecutablePath` exported; `ModelProbeFailed` tagged error.
- G *Correctness*: `ActivityNotFound` follows `project.ts:121`; `activities.run` resolves the refusal as data.
- H *Correctness*: the probe's `cwd` is `dataDir`, so project settings are not read; recorded as an accepted limit. `settingSources` stays unset.
- I *Correctness*: `BackgroundActivities` provided to `hostPlugins`; `extend` binds `register` to the plugin name.
- J *Correctness*: claims confirmed; Windows cleanup stays an open assumption.
- K *Project rules*: ADR-0032 supersedes the `ADR-0019:83` bullet; index updated.
- L *Hardening*: hung first probe bounded by `MODEL_PROBE_TIMEOUT`; joining test added.

### Round 3

**Applied**
- 1 *Correctness*: events are encoded in the preload; `dispatch` passes decoded events (`host-api.ts:122-124`, `164-173`).
- 2 *Correctness*: reconnect dispatches `ActivitiesChanged.make({})` and `ModelsChanged` in a separate effect, so a failure does not skip the existing dispatch (`host-api.ts:134-147`).
- 3 *Correctness*: `ModelCatalogFeed` captures its scope, stamps the first state before `start` returns, uses `Effect.forkIn`; pre-`start` value is `Loading` with revision 0 and unreachable by `GetModels`.
- 4 *Correctness*: a failing `extend` on reload keeps the previous version (`plugin-registry.ts:455-458`).
- 5 *Correctness*: `TimeoutError` mapped to `ModelProbeFailed`; probe block marked as pseudo-code.
- 6 *Correctness*: `pathToClaudeCodeExecutable` spread only when defined, as at `session.ts:455-457`.
- 7 *Law of Demeter*: `makeModelCatalog` takes `Pick<HostPluginContext, 'dataDir' | 'activities'>`.
- 8 *Define Errors Out of Existence*: a duplicate id is a defect; `ActivityIdTaken` removed from the API and the `@dia/plugin` re-exports.
- 9 *Project rules*: JSDoc requirement stated for every export, including hooks, layers and `window.dia` members.
- 10 *Consistency*: tests list extended.
- 11 *Accessibility*: one `role="status"` region on the Plugins page.

Round 3 raised no blocker; its four major findings were applied. The `medium` budget (3 rounds) is spent.

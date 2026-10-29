# Adapter settings, the user's Claude Code install, and the model picker (issue #50)

Scope: layer. Spans `plugins/claude-code` (adapter), `src/host` (kernel), `src/shared` (domain, IPC), `src/preload`, `src/main` (file dialog) and the renderer (Settings page, composer, New agent form, transcript).

## Name and Purpose

dia runs the Claude Code install on the user's machine, reports whether that install works, and keeps per-adapter model preferences (favourite, hidden, defaults for new agents) that both model pickers use.

## Modules

| Module | Location | Owns |
| --- | --- | --- |
| `ClaudeInstall` | `plugins/claude-code/claude-install.ts` (replaces `claude-executable.ts`) | the install path override in `<dataDir>/install.json`; resolving override → `PATH` → Windows shim target, at each check and each query start |
| `ClaudeHealth` | `plugins/claude-code/health.ts` | the health state; the check sequence (resolve, `--version`, `probeInstall`); serialising checks; the startup-failure report from sessions |
| Model catalog | `plugins/claude-code/model-catalog.ts` | unchanged except `probeModels(install)` resolves the path through `ClaudeInstall` instead of the module-level `claudeExecutablePath` |
| Session | `plugins/claude-code/session.ts` | `setModel` (applied at dispatch), `ModelChanged`, reading `startup_failure_reason`, the not-installed session; the path from `ClaudeInstall` replaces `claudeExecutablePath` (`session.ts:320`) |
| Backend | `plugins/claude-code/backend.ts`, `host.ts` | `makeClaudeCodeBackend({ catalog, install, health })`; setup builds `install`, then `catalog`, then `health(install, catalog.refreshModels)`, and forks the startup health check |
| Backend contract | `src/host/session/agent-backend.ts` | `AgentBackend.status`, `checkHealth`, `setInstallPath`; `AgentSession.setModel`; `unavailableBackend`, `backendMethods` |
| Protocol | `src/host/session/protocol.ts` | `ModelChanged` outbound message |
| Pane supervisor | `src/host/services/pane-supervisor.ts` | `PaneHandle.setModel`; mapping `ModelChanged` → `PaneModelChanged` (next to `ConversationCompacted`, `pane-supervisor.ts:237`) |
| `PaneWorkspace.setModel` | `src/host/services/pane-workspace.ts` | persisting `PaneConfig.model` via `updateTabConfig` and applying it to a live session, as `setPermissionMode` does |
| `AdapterStatusFeed` | `src/host/services/adapter-status-feed.ts` | forwarding the backend's status to the renderer with a `revision`; copies `ModelCatalogFeed`, unify only if a third feed appears |
| `ModelPreferences` | `src/host/services/model-preferences.ts` | per-adapter favourites, hidden models and defaults; the last-visible rule; `ModelPreferencesChanged` |
| `SettingsStore` | `src/host/services/settings-store.ts` | the `adapters` block of `settings.json` |
| Plugin API | `src/host/plugin-api.ts`; `src/shared/plugin/manifest.ts`; every `plugins/*/plugin.json` | exporting the `adapter-status` schemas to plugins; `PLUGIN_API_VERSION` and each `api` 0.0.1 → 0.0.2 |
| Shared shapes | `src/shared/domain/adapter-status.ts`, `src/shared/domain/model-preferences.ts` | what crosses the adapter/kernel and host/renderer boundaries; `pickerModels` |
| RPCs, events | `src/shared/ipc/rpc.ts`, `src/shared/ipc/contract.ts` | the calls below; `PROTOCOL_VERSION` 0.0.1 → 0.0.2 |
| Preload | `src/preload/host-api.ts`, `src/preload/index.ts`, `DiaApi` in `contract.ts` | the new commands and queries, `onAdapterStatusChanged`, `onModelPreferencesChanged`, `onModelChanged`, `pickFile` |
| File dialog | `src/main/ipc/window-ipc.ts` | `chooseFile` channel next to `chooseDirectory` |
| Settings page | `src/renderer/src/components/settings-page.tsx`, `app.tsx`, `command-palette.tsx` | Adapters → Claude Code → Health, Defaults, Models |
| Model picker | `plugins/chat/model-picker.tsx`, `pane.tsx`, `chat.tsx` | the composer's ghost Select |
| New agent form | `model-field.tsx`, `pane-creation-form.tsx` | the filtered list and the defaults |
| Hooks | `src/renderer/src/hooks/use-adapter-status.ts`, `use-model-preferences.ts` | newest snapshot per component, as `useModelCatalog` does |
| Install notice | `src/renderer/src/components/install-notice.tsx` | the neutral line above the composer and in the New agent form |
| Transcript | `src/renderer/src/lib/pane-chat.ts`, `pane-chat-atoms.ts` | the `Model → …` notice |
| Packaging | `electron-builder.yml` | drop `node_modules/@anthropic-ai/claude-agent-sdk-*/**` from `asarUnpack`; add `'!node_modules/@anthropic-ai/claude-agent-sdk-*/**'` to `files`, because the SDK still installs its platform package as an optional dependency (`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64` exists) |
| Docs | `docs/adr/0037-run-the-users-claude-code-install.md` + index; `docs/reasoning/2026-07-19-packaging-asarunpack-claude-cli.md` | the ADR; points 2–3 marked superseded by ADR-0037 |

## Interface

### ClaudeInstall (`plugins/claude-code/claude-install.ts`)

```ts
/** The shape `makeClaudeInstall` returns; other adapter modules depend on this type. */
export interface ClaudeInstall {
  /**
   * The path to spawn, read again on every call. With an override stored: the override passed
   * through `resolveSpawnablePath` (so `claude.cmd` becomes the `claude.exe` beside it), or none
   * when it is not spawnable; a stored override never falls through to `PATH`. Without one:
   * `claude` on `PATH`, or none.
   */
  readonly resolve: Effect.Effect<Option.Option<string>>
  /** The stored override. */
  readonly override: Effect.Effect<Option.Option<string>>
  /** Stores (`Some`) or clears (`None`) the override. Queries started afterwards use it; running sessions keep their process. */
  readonly setOverride: (path: Option.Option<string>) => Effect.Effect<void>
}

/**
 * Builds the {@link ClaudeInstall} that keeps its override in `<dataDir>/install.json`. `isFile`
 * says whether a path is an existing file; pass `isExistingFile`, or a stub in tests.
 */
export const makeClaudeInstall: (
  ctx: Pick<HostPluginContext, 'dataDir'>,
  isFile: (path: string) => boolean
) => Effect.Effect<ClaudeInstall, never, FileSystem.FileSystem | Path.Path>

/**
 * Resolves `command` (an absolute path or a bare name) to a path the Agent SDK can spawn without
 * a shell, or none when nothing exists. Pure: `env` and `isFile` are injected.
 */
export const resolveSpawnablePath: (
  command: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  isFile: (path: string) => boolean
) => Option.Option<string>
```

Rules `resolveSpawnablePath` implements (issue #50 §1, `.repos/t3code/.../ClaudeExecutable.ts`): a bare name is looked up in `PATH`, on Windows with each `PATHEXT` extension; a `.cmd`, `.bat` or `.ps1` result is replaced by `node_modules/@anthropic-ai/claude-code/bin/claude.exe`, else `node_modules/@anthropic-ai/claude-code/cli.js`, in the shim's directory; a shim with neither is none.

### ClaudeHealth (`plugins/claude-code/health.ts`)

```ts
/** The shape `makeClaudeHealth` returns. */
export interface ClaudeHealth {
  /** Streams the current {@link AdapterStatus}, then every change. */
  readonly status: () => Stream.Stream<AdapterStatus>
  /** Runs the check sequence and completes when it ends. A call during a running check waits for that check instead of starting another. */
  readonly check: Effect.Effect<void>
  /** Called by a session whose query reported `startup_failure_reason`. `cli_version_too_old` sets `HealthError` "Update Claude Code"; other reasons leave health unchanged (the pane shows its own error). */
  readonly reportStartupFailure: (reason: SDKStartupFailureReason) => Effect.Effect<void>
}

/**
 * Builds {@link ClaudeHealth} for `install`, starting in `HealthNotChecked`. Runs no check itself.
 * When a check moves health to `HealthReady` from `HealthNotInstalled`, `HealthError`,
 * `HealthUnknown` or `HealthNotSignedIn` (not from `HealthNotChecked`: the catalog makes its own
 * startup read) it runs `refreshModels`, so a
 * model list that failed while Claude Code was missing or signed out recovers without a manual
 * Refresh.
 */
export const makeClaudeHealth: (
  install: ClaudeInstall,
  cwd: string,
  refreshModels: () => Effect.Effect<void>,
  probe?: (path: string, cwd: string) => Effect.Effect<AccountInfo, InstallProbeFailed>
) => Effect.Effect<ClaudeHealth, never, ChildProcessSpawner | Scope.Scope>

/** `probeInstall` could not read the account; `message` says why. */
export class InstallProbeFailed extends Data.TaggedError('InstallProbeFailed')<{ readonly message: string }> {}

/** The account Claude Code reports, read by a query that starts no turn. */
export const probeInstall: (path: string, cwd: string) => Effect.Effect<AccountInfo, InstallProbeFailed>
```

`cwd` is the directory the probe query runs in (`host.ts` passes `ctx.dataDir`); `probe` defaults to `probeInstall`. The `--version` spawn uses Effect's `ChildProcessSpawner`; `host.ts` provides `@effect/platform-node/NodeServices`. `probeInstall` and `probeModels` share `withIdleQuery(path, cwd, use)` in `plugins/claude-code/idle-query.ts`, which runs a query that starts no turn and closes it afterwards.

Check sequence; each step ends the check when it decides the state:

| Step | Call | Outcome |
| --- | --- | --- |
| 1 | `install.resolve` | none with an override stored → `HealthError` "The configured install path cannot be run" with `installPath` (the file does not exist, or is a shim with no `claude.exe` or `cli.js` beside it); none without one → `HealthNotInstalled` |
| 2 | spawn `<path> --version`, 10 s timeout (`.js` entry: `node <path> --version`) | non-zero, spawn error or timeout → `HealthError` with the message, and the version when one was parsed |
| 3 | `probeInstall`: a query whose prompt never yields (`persistSession: false`, `strictMcpConfig: true`), awaiting `initializationResult()`; 60 s timeout | timeout or failure → `HealthUnknown`; `account.apiProvider` absent or `firstParty`, `tokenSource` `none`, no `subscriptionType`, no `apiKeySource` and `ANTHROPIC_API_KEY` unset (read through `Config`) → `HealthNotSignedIn` (`isSignedOut`); otherwise `HealthReady` with `email` and `subscriptionType` |

Checks run at adapter setup (forked; setup does not wait), from `checkHealth`, after `setInstallPath`, and from the Settings page when the last `checkedAt` is older than 5 minutes (`Duration.minutes(5)` in the renderer constant). It never polls. The health check is not a background activity: activities reschedule themselves, which is polling.

Every `query()` the adapter starts, including `probeInstall` and `probeModels`, passes `env: { ...process.env, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' }` (`env` replaces the subprocess environment, `sdk.d.ts:1693`). `runSession` reads `startup_failure_reason` from each `result` message before the reducer and calls `health.reportStartupFailure`. Verified (`sdk.d.ts:5972`): the variable gates the result for failures that used to end with stderr alone. Unverified: the value it expects, whether `cli_version_too_old` is among those failures, and whether an old CLI sets the field at all ("absent … from older producers", `sdk.d.ts:5972`). Check it by running an old CLI. If the field never arrives, the "Update Claude Code" health state goes on the `verify-in-app` "Not exercised" list with that reason.

### Session (`plugins/claude-code/session.ts`)

`setModel(model)` stores the requested model in `desiredModelRef`, which starts as `options.config.model`, as `setThinkingLevel` uses `desiredLevelRef` (`session.ts:625`). `restartForThinkingChange` (`session.ts:706`) returns `true` when it restarted; when it restarts it reads `desiredModelRef` and starts the new query with `{ ...config, thinkingLevel, model }`, and `startQuery` sets `configRef` (`session.ts:701`). When it returns `false` and `desiredModelRef` differs from `configRef`'s model, `dispatch` calls `Query.setModel(model)` on the live query and sets `configRef` to `{ ...config, model }`. When the model changed by either path, the session emits `ModelChanged { model }` before `UserMessagesSent`, all under `restartLock`. A running turn therefore finishes on its model, the next turn uses the new one, and restarts keep it because they start from `configRef` (`session.ts:708`, `:786`). Choosing the model already in use leaves `desiredModelRef` equal to `configRef`, so nothing is applied or emitted.

`openClaudeCodeSession(options, install, reportStartupFailure)` resolves the path once and hands `runSession` a `SessionLaunch { path, reportStartupFailure }`, which every query the session starts (including restarts) uses.

When `install.resolve` is none, `openClaudeCodeSession` starts no query and returns a session whose `ended` is `The configured install path cannot be run: <path>` when an override is stored, else `NOT_INSTALLED_REASON` ("Claude Code is not installed", exported from `claude-install.ts`). The supervisor shows it as the pane error "Pane session ended unexpectedly: Claude Code is not installed" and logs it at error level (`pane-supervisor.ts:636-648`). The kernel refuses nothing. The New agent form blocks creating an agent, and an existing tab shows the error on its next send.

### Backend contract (`src/host/session/agent-backend.ts`)

```ts
interface AgentSession {
  // existing members …
  /** Makes the turns dispatched from now on use `model`; a running turn finishes on its model. Choosing the model in use does nothing. */
  readonly setModel: (model: string) => Effect.Effect<void>
}

interface AgentBackend {
  // existing members …
  /** Streams the adapter's install status, starting with the current one. */
  readonly status: () => Stream.Stream<AdapterStatus>
  /** Re-checks the install and completes when the check ends; the outcome arrives through `status`. */
  readonly checkHealth: () => Effect.Effect<void>
  /** Stores (`Some`) or clears (`None`) where the adapter finds its agent install, then re-checks. Sessions started afterwards use it. */
  readonly setInstallPath: (path: Option.Option<string>) => Effect.Effect<void>
}
```

`unavailableBackend.status` streams one `HealthError` "The claude-code adapter is not loaded"; its `checkHealth` and `setInstallPath`, and `unavailableSession.setModel`, log and do nothing. `backendMethods` lists `status`, `checkHealth` and `setInstallPath`.

### Shared shapes (`src/shared/domain/adapter-status.ts`)

```ts
HealthNotChecked   = TaggedStruct('HealthNotChecked', {})
HealthNotInstalled = TaggedStruct('HealthNotInstalled', { checkedAt: DateTimeUtcFromString })
HealthError        = TaggedStruct('HealthError', { message: String, version: optional(String), installPath: optional(String), checkedAt: DateTimeUtcFromString })
HealthUnknown      = TaggedStruct('HealthUnknown', { message: String, version: String, installPath: String, checkedAt: DateTimeUtcFromString })
HealthNotSignedIn  = TaggedStruct('HealthNotSignedIn', { version: String, installPath: String, checkedAt: DateTimeUtcFromString })
HealthReady        = TaggedStruct('HealthReady', { version: String, installPath: String, email: optional(String), subscriptionType: optional(String), checkedAt: DateTimeUtcFromString })
AdapterHealth      = Union([HealthNotChecked, HealthNotInstalled, HealthError, HealthUnknown, HealthNotSignedIn, HealthReady])

/** `checking` is true while a check runs; `installPathOverride` is the stored override, null when `PATH` is used. */
AdapterStatus         = Struct({ health: AdapterHealth, checking: Boolean, installPathOverride: NullOr(String) })
AdapterStatusSnapshot = Struct({ revision: Int, status: AdapterStatus })
```

Types derive from the schemas (`export type X = typeof X.Type`); values are built with `.make`. `src/host/plugin-api.ts` exports all of them.

### Shared shapes (`src/shared/domain/model-preferences.ts`)

```ts
/** A model's preference. A model with neither is absent from the record, so favourite and hidden cannot both hold. */
ModelPreference = Literals(['favourite', 'hidden'])

AgentDefaults = Struct({ model: optional(NonEmptyString), thinkingLevel: optional(ThinkingLevel), permissionMode: optional(StartupPermissionMode) })

/** Preferences of one adapter; `models` is keyed by `ModelOption.value`. */
AdapterPreferences = Struct({ models: Record(String, ModelPreference), defaults: AgentDefaults })

/** As `ModelCatalogSnapshot`: keep the higher `revision` when a reply and an event race. */
ModelPreferencesSnapshot = Struct({ revision: Int, preferences: AdapterPreferences })

/** `SetModelPreference` refused to hide a model because no listed model would stay visible, or the model list is not known. */
LastVisibleModel = Schema.TaggedError('LastVisibleModel', { message: String })

/**
 * The picker's groups for `models`, in catalog order: `favourites`, then `others` (neither
 * favourite nor hidden). When every model is hidden, `others` is every model.
 */
export const pickerModels: (models: ReadonlyArray<ModelOption>, prefs: AdapterPreferences) => {
  readonly favourites: ReadonlyArray<ModelOption>
  readonly others: ReadonlyArray<ModelOption>
}
```

### ModelPreferences (`src/host/services/model-preferences.ts`)

```ts
/**
 * The preferences of the loaded adapter: the first `HostPlugins.list` entry with
 * `category === 'adapter'` and status `Loaded`. With no adapter loaded, `current` is empty
 * preferences and changes are refused with a logged warning. Changes are serialised, so the
 * last-visible check and the write happen together. `set` with `'hidden'` fails with
 * `LastVisibleModel` when the model list is not `Ready` or when every listed model would be
 * hidden. Each change publishes `ModelPreferencesChanged` with a revision of
 * `max(previous + 1, Clock.currentTimeMillis)`, as `ModelCatalogFeed` stamps its snapshots.
 */
class ModelPreferences extends Context.Service<ModelPreferences, {
  readonly current: Effect.Effect<ModelPreferencesSnapshot>
  readonly set: (model: string, preference: Option.Option<ModelPreference>) => Effect.Effect<void, LastVisibleModel>
  readonly setDefaults: (defaults: AgentDefaults) => Effect.Effect<void>
}>()('ModelPreferences') {}
```

`SettingsStore` gains `adapters: optional(Record(String, AdapterPreferences))`, with `getAdapterPreferences(adapter)` (empty preferences when absent) and `setAdapterPreferences(adapter, prefs)`.

### RPCs and events

`SetModel` is a named `Schema.TaggedStruct` in `contract.ts`, wrapped by `withRequestId` and deduplicated with `once` by `paneId`. The app setters (`SetModelPreference`, `SetAgentDefaults`, `SetInstallPath`) carry no `commandId`: each sets a value, so a repeat is harmless, as `SetTheme` is.

| Name | Kind | Shape |
| --- | --- | --- |
| `SetModel` | pane command | `{ paneId: Uuid, model: NonEmptyString }` → `PaneWorkspace.setModel` |
| `SetModelPreference` | app setter | `{ model: NonEmptyString, preference: NullOr(ModelPreference) }`, error `LastVisibleModel` |
| `SetAgentDefaults` | app setter | `{ defaults: AgentDefaults }` |
| `SetInstallPath` | app setter | `{ path: NullOr(NonEmptyString) }` |
| `GetAdapterStatus` | query | → `AdapterStatusSnapshot` |
| `CheckAdapterHealth` | safe to repeat, no `commandId` | → void; waits for a running check (added to the `DiaRpcs` JSDoc next to `RefreshModels`) |
| `GetModelPreferences` | query | → `ModelPreferencesSnapshot` |
| `AdapterStatusChanged` | global event | `{ snapshot: AdapterStatusSnapshot }` |
| `ModelPreferencesChanged` | global event | `{ snapshot: ModelPreferencesSnapshot }` |
| `PaneModelChanged` | pane event | `{ paneId, model }` |

Tests: the `model` field of `SetModel` and of `SetModelPreference` reaches the handler unchanged.

The `makeDiaRpcHandlers` JSDoc (`rpc-handlers.ts:24`) lists `SetModelPreference` with `RegisterProject` and `RemoveProject` as the calls that return a typed error.

### Renderer

- **Settings page** (`settings-page.tsx`; since `docs/designs/settings-dialog-and-inset-sidebar.md` the Claude Code page of the Settings dialog, `settings/claude-code-settings.tsx`, opened with `openSettings({ page: 'adapters', adapter: 'claude-code' })`): frame copied from `PluginsPage`, opened from the command palette ("Settings") or `openSettingsPage()`, Esc closes. Health, Defaults and Models are laid out as in issue #50 §3, under a "Claude Code" heading; there is no section list while only one adapter exists. The model list has three sections: Favourites (in the order they were starred), Other models (catalog order), and Hidden, a disclosure button with a count that starts collapsed. Starring or hiding a row moves it to its section and keeps focus on it, or on the row that takes its place when it moves into a collapsed Hidden. The rows have one tab stop, `↑`/`↓` move between shown rows, and `F`/`H` toggle favourite and hidden on the focused row. A refused hide shows the refusal message under the list. With no default model saved, the Defaults model choice shows the first listed model. `window.dia.pickFile()` is a window-level call (`CHANNEL.chooseFile` in `window-ipc.ts`), not a Host RPC. `Change` opens `window.dia.pickFile()` and calls `setInstallPath`; a `Use PATH` button clears the override. On open, the page calls `checkAdapterHealth` when `health` has a `checkedAt` older than 5 minutes; it does not call it while `health` is `HealthNotChecked`, because the startup check is running.
- **Model picker** (`model-picker.tsx`): first in the composer's `InputGroupAddon`, in the `ThinkingLevelSelect` ghost style. It lists `pickerModels(...)`: favourites under a "Favourites" heading, others under "Models", a divider, `Manage models` (opens the Settings page). The New agent form's model field uses the same headings. A tab model outside the list shows as its raw id in mono. Choosing a different model calls `window.dia.setModel`.
- **New agent form**: `ModelField` renders `pickerModels(...)`. The existing effect that replaces an unlisted `value` with `models[0]` (`model-field.tsx:49-54`) is deleted. The new effect only seeds `value` while it is `undefined`: `defaults.model` when listed, else the first listed model. A chosen `value` that leaves the list stays selected, is marked "No longer offered", and the form disables Start until the user picks again. The `ModelField` JSDoc is updated to match. The initial thinking level and permission mode come from `defaults.thinkingLevel` and `defaults.permissionMode`, falling back to `DEFAULT_THINKING_LEVEL` and `'auto'`.
- **Transcript**: `PaneModelChanged` appends a `notice` message `Model → <displayName>` (raw id when not in the catalog), as `PaneConversationCompacted` does. `reducePaneChat` stays pure: `pane-chat-atoms.ts` keeps the newest model list synchronously and attaches `displayName` to the event (`PaneModelChangeNotice`) before it reaches the reducer, so the notice keeps its place before the user's message.
- **Install notice**: shown when `health` is `HealthNotInstalled` ("Claude Code is not installed.") or `HealthNotSignedIn` ("Claude Code is not signed in. Run `claude auth login` and try again."), and for a `HealthError` with `installPath` and no `version` (the step-1 message), with a link that opens the Settings page; the New agent form disables Start while it shows.

## Design Rationale

**Health is checked separately from the model list.** The model list keeps its daily background activity and cache. Health is checked on demand only, because the issue rules out polling and an activity always reschedules itself. The two queries do not share state: `probeInstall` returns the account and records nothing, and `ClaudeHealth` records the outcome.

**The install path is read at each query start.** `ClaudeInstall.resolve` reads `install.json` and `PATH` every time, so installing Claude Code or changing the override applies to the next check and the next session without reloading the adapter. Running sessions keep their process. This removes the issue's "Applies after restart" note: that note assumed the path was fixed at setup.

**The override lives in the adapter's data directory, behind adapter-neutral names.** A shipped plugin cannot read `SettingsStore` (the user chose `dataDir`). The kernel sees only "install path" (`setInstallPath`, `installPathOverride`, `installPath`); PATH lookup and shim resolution stay in `claude-install.ts`.

**A model's preference is one value, not two flags.** `Record<value, 'favourite' | 'hidden'>` makes "favourite and hidden" unrepresentable (Define Errors Out of Existence). The last-visible rule depends on the catalog, so `ModelPreferences` checks it against `ModelCatalogFeed.current` inside a serialised change, and `pickerModels` falls back to every model when a catalog change hides all of them.

**`setModel` applies at dispatch.** `Query.setModel` changes "subsequent responses" (`sdk.d.ts:2970`). Whether it affects a turn already running is unverified, so the session calls it when the next turn is dispatched. That is also when the session emits `ModelChanged`, which puts the divider before that turn.

**Plugin API version 0.0.2.** `plugin-api.ts` exports new host values, and the `AgentBackend` contract gains methods. Below 0.1.0 the patch versions must match (`manifest.ts`, `isApiCompatible`), so every `plugins/*/plugin.json` moves to `0.0.2` with the host.

**Logging.** Every new module logs through Effect logger methods: health transitions, override changes, preference changes, `ModelChanged`, and refused hides.

## Verify list

- The `files` negation `!node_modules/@anthropic-ai/claude-agent-sdk-*/**` keeps the platform binary out of `app.asar`. This is unverified: no source in the repo or `docs/llms/` confirms that `files` patterns apply to `node_modules`. Check it by building the installer and listing `app.asar`.
- `pathToClaudeCodeExecutable` with a user `claude.exe` whose version differs from the SDK's 0.3.311 (issue #50, Unverified).
- `cli_version_too_old` reaching `runSession` (see ClaudeHealth).

## Rejected Alternatives

**Fallback to the bundled binary**: rejected by the user, because a silent fallback hides a broken install.

**A minimum CLI version check**: rejected, because `cli_version_too_old` already reports it.

**One query for health and the model list**: rejected. It would make the model probe record health, and it would tie health to the models activity's hourly retry and daily schedule.

**Renderer-only model divider**: rejected, because a divider appended during a running turn lands inside the streaming reply.

**A kernel settings accessor for plugins**: rejected by the user in favour of `dataDir`.

## Refinement Record

### Round 1

**Applied**
- *Correctness*, blocker: `setModel` only updated `configRef`. It now applies `Query.setModel` at dispatch through `desiredModelRef`.
- *Correctness*, blocker: the startup-failure path was undesigned. Added `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` with spread `env`, reading in `runSession`, and the unverified note.
- *Correctness*, major: health rode the models activity, which reschedules itself (polls). Health is now an on-demand check, and the models activity is unchanged.
- *Correctness*, major: the executable was fixed at setup, so Check could not recover from not-installed. It is now resolved at each check and query start, and `restartRequired` is removed.
- *Correctness*, major: plugin-api exports, `ModelChanged`, the supervisor mapping, `PaneHandle.setModel` and the backend constructor change were missing. All are added.
- *Correctness*, major: the version-bump reason was wrong. It is restated, and all `plugin.json` files are listed.
- *Correctness*, major: thinking and permission defaults were unused. The New agent form now applies them.
- *Correctness*, major: `ModelPreferences` had a race and no rule for a list that is not Ready. Changes are serialised, a list that is not Ready refuses hides, and the adapter lookup and the no-adapter case are defined.
- *Correctness*, major: `ModelField` could start an agent with a model that left the list. Such a model is now marked "No longer offered" and blocks Start.
- *Correctness*, minor: the notice link to Settings and the not-installed behaviour of an existing tab are added.
- *Project rules*, major: commands are named TaggedStructs with `commandId`, `LastVisibleModel` is defined, and the payload pass-through tests and the preload surface are listed.
- *Project rules*, minor: added the logging rationale, and `resolveSpawnablePath`'s JSDoc now states the contract only.
- *Project rules*, minor: removed the unused `ExecutableSource` and defined the `ClaudeInstall` type.
- *Information Hiding*, strict: renamed to `setInstallPath` and `installPath`.
- *CQS / POLA*: the probe no longer records health.
- *Information Hiding*: `probeInstall` moved to `health.ts`.
- *AHA*: the feed duplication is stated in the table.
- *Names as Documentation*: the `Health*` prefix is used throughout, and the field is `subscriptionType`.
- *Correctness* (not checked by the critique): the SDK platform package is installed, so it is excluded through `files`.

**Rejected**: none.

**Escalated**: none.

### Round 2

**Applied**
- *Fail Fast / POLA*, major: a broken override fell back to `PATH`. A stored override never falls through now, and step 1 reports `HealthError`.
- *Correctness*, major: preferences had no revision, so a late reply could overwrite a newer event. Added `ModelPreferencesSnapshot`.
- *Correctness*, major: the not-installed path was described inaccurately. It now gives the supervisor's real message, and creation is blocked only by the form.
- *Correctness*, major: the model list stayed stale after recovery. A transition to `HealthReady` now runs `refreshModels`, and the build order is install → catalog → health.
- *Correctness*, minor: the env-var note is split into its verified and unverified parts, and the probes pass the same `env`.
- *Correctness*, minor: `desiredModelRef` now starts as `options.config.model`.
- *Correctness*, minor: a thinking restart now starts on the new model instead of calling `setModel` after the restart.
- *Project rules*, minor: the rpc-handlers JSDoc lists the typed error, and `InstallProbeFailed` is defined.
- *Success criteria*, minor: added the `claude auth login` notice copy, the override passing through `resolveSpawnablePath`, and `Duration.minutes(5)`.
- *Correctness* (from the "Verified" notes): the `files` negation is unverified, and it is now on the Verify list.

**Rejected**
- *AHA*: extending `resolveAgentBackend` to return the plugin name. Rejected because it changes the return type for every caller of `resolveAgentBackend` when only `ModelPreferences` needs the name. ADR-0029 allows one adapter, so `HostPlugins.list` filtered by `category === 'adapter'` names the same plugin the backend is resolved from.

### Round 3

**Applied**
- *Correctness*, major: `dispatch` could not tell whether the thinking restart ran. `restartForThinkingChange` now returns a boolean and reads `desiredModelRef` itself.
- *Correctness*, major: the `HealthReady` transition re-probed models on every launch. A transition from `HealthNotChecked` is now excluded.
- *Correctness*, minor: removed the dangling "criterion 6" reference.
- *POLA*, minor: a broken override no longer reports "not installed". The session reason, the step-1 wording and the install notice now cover it.
- *Correctness*, minor: removing `ModelField`'s existing auto-select effect and updating its JSDoc are now stated.
- *Correctness*, minor: the Settings page skips the stale check while health is `HealthNotChecked`.
- *Define Errors Out of Existence*, minor: `SetInstallPath.path` is `NonEmptyString`.

**Rejected**: none.

**Escalated**: none.

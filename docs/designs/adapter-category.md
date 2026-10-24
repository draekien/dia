# Adapter category and kernel pending user input

Issue #9, the step after `docs/designs/claude-code-adapter.md`. Implements the parts of ADR-0029 that the adapter step left: the `adapter` category, the removal of `ESSENTIAL_PLUGINS`, and `pending-user-input` in the kernel.

## Scope

| Change | Files |
| --- | --- |
| `PluginManifest` becomes a union discriminated on a required `category: "feature" \| "adapter"`; every `plugin.json` states it | `src/shared/plugin/manifest.ts`, every `plugins/*/plugin.json`, test fixtures |
| `PluginInfo` gets `category` | `manifest.ts`, `plugin-registry.ts`, `rpc.ts` (`PROTOCOL_VERSION` 5 → 6) |
| The registry refuses to unload or reload a running adapter | `plugin-registry.ts` |
| An adapter loads at startup with the eager plugins, whatever its `load` says | `plugin-registry.ts` |
| The plugin sources refuse an override of an adapter, and an override whose manifest says `adapter` | `src/host/plugins/plugin-sources.ts` |
| The plugins page disables Reload, Unload and Set folder for a loaded adapter | `src/renderer/src/components/plugins-page.tsx` |
| `ESSENTIAL_PLUGINS` and `isEssentialPlugin` are deleted; `git-ops` becomes an ordinary feature | `manifest.ts` and its users |
| `makePendingUserInput` moves to the kernel; `plugins/permissions`, `PENDING_USER_INPUT_KEY` and `resolvePendingUserInput` are deleted | `src/host/session/pending-user-input.ts` (new), `pending-user-input-resolver.ts` (deleted) |
| `ToolGate` is deleted; `AgentSessionOptions` takes `tools`, and the adapter creates one `PendingUserInput` per session | `agent-backend.ts`, `pane-supervisor.ts`, `plugins/claude-code/session.ts` |

Out of scope: renaming `git-ops` to `worktrees` and the project-directory fallback when it is unloaded (next item of #9). Unloading `git-ops` after this change makes new worktree panes fail with `WorktreeCreateError`, as `resolveGitOps` already does when the plugin is missing.

## Interfaces

```ts
// src/shared/plugin/manifest.ts
/** `adapter`: translates between dia and one agent; loads at startup from the shipped copy only and is never unloaded, reloaded or overridden. `feature`: one user-facing feature. */
export const PluginCategory = Schema.Literals(['adapter', 'feature'])
export type PluginCategory = typeof PluginCategory.Type

/** A feature plugin's `plugin.json`. Fields as today. */
export const FeatureManifest = Schema.Struct({
  name: PluginName,
  api: Schema.String,
  category: Schema.Literal('feature'),
  host: Schema.optional(Schema.String),
  renderer: Schema.optional(Schema.String),
  inject: Schema.optional(Schema.Array(Schema.String)),
  load: Schema.optional(PluginLoadMode)
})

/** An adapter plugin's `plugin.json`: a required `host`, and no `renderer`, `inject` or `load`. */
export const AdapterManifest = Schema.Struct({
  name: PluginName,
  api: Schema.String,
  category: Schema.Literal('adapter'),
  host: Schema.String,            // messageMissingKey: 'an adapter needs a "host" entry, because it runs in the Host'
  renderer: forbidden('an adapter has no UI, so it cannot declare "renderer"'),
  inject: forbidden('an adapter cannot declare "inject": a reload of the plugin it injects from would close the adapter'),
  load: forbidden('an adapter always loads at startup, so it cannot declare "load"')
})
// forbidden(message) = Schema.optionalKey(Schema.Never.annotate({ message }))

/** Contents of `plugin.json`. Decode with `{ errors: 'all' }` so every problem is reported. */
export const PluginManifest = Schema.Union([FeatureManifest, AdapterManifest]).annotate({
  message: 'plugin.json must declare "category" as "feature" or "adapter"'
})

export const PluginInfo = Schema.Struct({
  name: PluginName,
  category: PluginCategory,
  origin: PluginOrigin,
  root: Schema.String,
  status: PluginStatus,
  memoryBytes: ...
})
```

```ts
// src/host/session/agent-backend.ts
export interface AgentSessionOptions {
  readonly config: PaneConfig
  readonly resume: Option.Option<SessionId>
  readonly emit: (message: OutboundMessage) => Effect.Effect<void>
  readonly tools: ReadonlyArray<DiaTool>
}
```

```ts
// src/host/session/pending-user-input.ts
export const Superseded = Schema.TaggedStruct('Superseded', {})
export type UserInputResolution = PermissionResponse | QuestionResponse | PlanReviewResponse | Superseded
export interface PendingUserInput { register; resolve; interruptAll; drop; isPending } // unchanged
/** Creates an empty registry; call once per agent session. */
export const makePendingUserInput: () => PendingUserInput
```

`@dia/plugin` adds `makePendingUserInput` and drops `ToolGate`, `PENDING_USER_INPUT_KEY` and `resolvePendingUserInput`.

## Behaviour

### Category of a plugin

Each registry entry stores `category`, read from the manifest's discriminator. A successful load sets it from the loaded manifest, and a failed load keeps the previous value, so an adapter that fails still reports `adapter`. For a plugin with no entry, or an entry that has never loaded, the registry peeks the manifest at its source root; when the manifest cannot be read, the category is `feature`. `failedInfo` (no plugin of that name) reports `feature`. `unload` and `load` read the category the same way before deciding to refuse.

### Registry

| Call | Adapter, running (`Loaded`, `RestartRequired`) | Adapter, `Failed` or not yet loaded | Feature |
| --- | --- | --- | --- |
| `load` | Refused: returns its `PluginInfo` unchanged, logs `Refused to reload an adapter plugin` | Loads | Loads or reloads (unchanged) |
| `unload` | Refused: returns its `PluginInfo` unchanged, logs `Refused to unload an adapter plugin` | Refused the same way | Unloads (unchanged) |
| `start` | Loaded in the eager pass (an adapter manifest has no `load`) | | Eager or lazy by `load` (unchanged) |

Retrying an adapter that failed at startup is a first load, not a reload, so it is allowed.

### Adapter contract checks

A plugin whose manifest declares `category: "adapter"` loads only if it meets the adapter contract. The contract is checked in two stages, and each stage reports every problem it finds in one `Failed` message. The message appears on the plugins page, in the result of `plugin_reload`, and in `dia.log`.

**Stage 1: the manifest.** `AdapterManifest` encodes the rules, so decoding `plugin.json` checks them. The loader and the renderer decode with `{ errors: 'all' }`, and nothing is imported when decoding fails. Example of a manifest with no `host` that declares `renderer` and `inject` (verified against effect's decoder with a prototype):

```
Invalid "plugins/claude-code/plugin.json": SchemaError(an adapter needs a "host" entry, because it runs in the Host
  at ["host"]
an adapter has no UI, so it cannot declare "renderer"
  at ["renderer"]
an adapter cannot declare "inject": a reload of the plugin it injects from would close the adapter
  at ["inject"])
```

A manifest with no `category`, or an unknown one, fails with `plugin.json must declare "category" as "feature" or "adapter"`.

**Stage 2: what setup provided.** After `setup` succeeds and before the status becomes `Loaded`, the registry runs the `adapterContract` dependency:

| Check | Problem text |
| --- | --- |
| the plugin provided `agentBackend` | `setup did not provide "agentBackend"` |
| `agentBackend.openSession` is a function | `"agentBackend.openSession" is not a function` |
| `agentBackend.readHistory` is a function | `"agentBackend.readHistory" is not a function` |

```
Plugin "claude-code" does not meet the adapter contract:
- setup did not provide "agentBackend"
```

A stage-2 problem closes the scope that setup opened, which removes everything the plugin provided, so `resolveAgentBackend` never returns the invalid value. A second adapter that also provides `agentBackend` already fails with `ServiceKeyTakenError` and needs no extra check.

The `agentBackend` check needs host types, so the host supplies it:

```ts
// src/shared/plugin/plugin-registry.ts — new required dependency of makePluginRegistry
/** Problems with what an adapter's setup provided; empty when it meets the contract. `provided` reads a value the plugin provided under a service key. */
readonly adapterContract: (provided: (key: string) => Option.Option<unknown>) => ReadonlyArray<string>
```

```ts
// src/host/session/agent-backend.ts
/** Problems with `value` as an {@link AgentBackend}; empty when it is one. */
export const agentBackendProblems: (value: Option.Option<unknown>) => ReadonlyArray<string>
/** The adapter contract the Host registry checks after an adapter's setup. */
export const checkAdapterContract: (provided: (key: string) => Option.Option<unknown>) => ReadonlyArray<string>
```

`host-plugins.ts` passes `checkAdapterContract`. `renderer-plugins.ts` passes `() => []`, because an adapter has no renderer entry. `resolveAgentBackend` logs `agentBackendProblems` when it falls back to the unavailable backend.

### Plugin sources

`PluginSources` decodes `plugin.json` with `PluginManifest` to read the category. `setOverride(name, directory)` fails with `InvalidOverrideError`:
- `"<name>" is an adapter and cannot be overridden` when the shipped copy of `name` declares `category: "adapter"`;
- `"<directory>" declares an adapter, and adapters load only from the shipped copy` when the override's manifest declares `category: "adapter"`.

`resolve(name)` ignores a saved override, with a warning, under either condition. An override for a name with no shipped copy is checked only by its own manifest.

### Plugins page

For `category === 'adapter'`: Unload and Set folder… are disabled, Reload is disabled unless the status is `Failed`, and the row reads `Adapter: it loads at startup from the bundled copy. Restart dia to apply a change.`

### Agent session

`SessionFactoryLive` builds `pluginTools` and passes `{ config, resume, emit, tools: pluginTools }`. The adapter calls `makePendingUserInput()` once in `openClaudeCodeSession` and uses it for the session's lifetime, including restarts. The `DenyAll` path, `inertPendingUserInput` and `pendingUserInputOf` are deleted: a session can always ask the user.

## Tests

- manifest: a valid feature and a valid adapter decode; an adapter with no `host` and with `renderer`, `inject` and `load` reports all four problems in one error; a missing or unknown `category` reports the category message; a feature with `renderer` and `inject` decodes.
- registry: unload of a loaded adapter returns `Loaded` and its scope stays open; load of a loaded adapter does not run its setup again; load of a failed adapter runs setup; an adapter with `load: "lazy"` has settled when `start` resolves; `list` reports `adapter` for a never-loaded adapter.
- adapter contract (registry, with a fake loader): a setup that provides nothing fails with `setup did not provide "agentBackend"`, its scope is closed, and `inject("agentBackend")` is empty afterwards; a feature whose setup provides nothing loads.
- `agentBackendProblems`: one case per row of the post-setup table, and an empty list for a valid backend.
- plugin sources: `setOverride` refuses a shipped adapter and an override manifest that declares `adapter`; `resolve` ignores a saved override of an adapter; overriding `git-ops` is accepted.
- pending user input: the existing seven tests move with the module.
- adapter session: existing `canUseTool` tests drop the `DenyAll` case and construct options with `tools`.
- plugins page: an adapter row has Unload and Set folder… disabled and shows the adapter note; a `Failed` adapter row has Reload enabled.
- pane supervisor: the existing tests keep passing with `tools` in place of `toolGate`.
- rpc: `PROTOCOL_VERSION` is 6.

## Docs

ADR-0029 "More Information": record that this step is implemented. `docs/designs/permissions-plugin.md`: superseded. `docs/designs/claude-code-adapter.md`: point to this spec for the follow-up. Reasoning entries that mention `ESSENTIAL_PLUGINS` or the `permissions` plugin are updated or marked superseded. Plan item for #9.

## Refinement record

Round 1 (inline, effort low).

| # | Finding | Lens / rule | Tag | Outcome |
| --- | --- | --- | --- | --- |
| 1 | "reads the category from the manifest it last loaded or peeked": `markFailed` clears `entry.manifest`, so a failed adapter would lose its category and become unloadable/overridable in the UI. | Correctness | major | Applied: the entry stores `category`, kept across a failed load. |
| 2 | "`load: Schema.optional(PluginLoadMode)` // ignored for an adapter": a manifest can state `category: "adapter", load: "lazy"`, which has no meaning. | Define Errors Out of Existence | major | Rejected: no wrong behaviour follows, because `start` treats every adapter as eager and nothing else reads `load`. A union manifest type would change every reader of `manifest.load` for a single shipped plugin. |
| 3 | "`setOverride` fails with `InvalidOverrideError` when the shipped copy declares adapter": `PluginSources` has no manifest decoder today (it only checks the file exists). | Correctness | minor | Applied: the spec says it decodes `plugin.json` with `PluginManifest`. |
| 4 | Sentence "re-exports `PluginCategory` is not needed; it re-exports" is garbled. | Project rules (literal prose) | minor | Applied. |
| 5 | Tests list no case for the plugins page, which has `plugins-page.test.tsx`. | Project rules (tests for changed code) | minor | Applied. |
| 6 | Adapter creates `PendingUserInput` itself rather than the kernel passing one in: does the adapter now own kernel state? | Information Hiding | minor | Rejected: only the session reads and writes the registry; passing it in would expose a value no kernel caller uses. The code stays in the kernel per ADR-0029 so a second adapter reuses it. |

No blocker or major finding is left standing after round 1, so the rounds stop.

Gate correction from the user: add validation for plugins that declare `adapter`, so an invalid adapter fails to load with a message that says what to fix. Settled as kernel-run contract checks only; no adapter-implemented health check. Added as "Adapter contract checks".

Second gate correction from the user: `PluginManifest` is a union discriminated on `category`. This reverses finding 2. `category` is required, because effect's union decoder only narrows to one member on a required literal key; with an optional `category`, an invalid adapter manifest reported `Expected "feature"` and lost its own problems (checked with a prototype). The manifest-stage checks moved from the registry into `AdapterManifest`.

# MCP server registry

`plugins/mcp` provides a Host service that holds every MCP server dia knows by name, with the plugin or user that contributed each one. Plugins add servers for their own lifetime; the user's servers are stored by `mcp` and held in the same list. Issue #220, step 1 of ADR-0072.

Scope: module (a new `mcp` host entry, a new exported module, a Settings page, and an amendment to ADR-0072's contribution contract line). Decisions confirmed by the user on 2026-11-08:

1. A name belongs to the first registration that claims it. A later `register` of that name fails with `McpServerNameTaken`; a Settings save that uses a name a plugin holds is refused. Settings never edits a plugin's server. This is `deepseek-harness`'s rule (`packages/mcp/mcp-manager/src/index.ts:288-303`, README "Registering a server from a plugin").
2. The Settings page edits all of the user's servers as one JSON map in the existing `McpServersEditor`, and lists plugin servers read-only. #197 replaces the editor.
3. Org job titles keep their inline `mcpServers`, and sessions receive the same servers as before. #222 moves job titles to server names.

## Current state (read at `e04a9dd`)

| Location | Holds |
|---|---|
| `plugins/mcp/plugin.json` | `renderer` only; `exports: ["servers.ts", "editor.ts"]` |
| `plugins/mcp/servers.ts` | `McpServer`, `McpServers`, `mcpServersDraft`, `readMcpServersDraft` |
| `plugins/mcp/renderer.ts` | provides `McpServersEditorKey` |
| `src/shared/plugin/api.ts:76-87` (contract), `src/shared/plugin/plugin-registry.ts` (`whenProvided`) | `whenProvided` runs its setup in a child scope closed before the contributor or the provider closes, and runs it again when every key is provided again. A setup that fails closes its child scope, is logged, and runs again only after one of its keys is withdrawn and provided again |
| `src/host/plugins/plugin-exports.test.ts:103` | every `exports` entry must be in the `include` of `tsconfig.plugin-exports.json` and `tsconfig.web.json`; an exported module may import only `effect`, `@dia/plugin`, `@dia-plugin/*` and relative files |
| `plugins/org/service.ts:92-116` | a `ServiceKey` guard built from a `MEMBERS` table of per-member checks |
| `src/shared/plugin/api.ts:194` | `ctx.database(migrations)`: one SQLite file per plugin, kept across reloads and restarts |
| `src/shared/plugin/api.ts:219` | `ctx.serve`: request/response and streaming calls from the plugin's own renderer entry |
| `plugins/org/host.test.ts:72-130` | a test harness that loads host setups through `makePluginRegistry` with `makePluginDatabase(':memory:', name)` |

## Modules

```
plugins/mcp/
  plugin.json         adds "host": "host.ts"; exports becomes ["servers.ts", "editor.ts", "registry.ts"]
  registry.ts         export @dia-plugin/mcp/registry: the service key, its guard, its types and its error
  calls.ts            internal: WatchServers, SaveUserServers (imported by host.ts and renderer.ts)
  store.ts            internal: migrations and read/write of the user's servers
  host.ts             internal: opens the store, makes the registry, registers the user's servers, provides the key, serves the calls
  make-registry.ts    internal: the registry state, `register`, `list`, `changes` and `replaceUser`
  settings-page.tsx   internal: the Settings page
  renderer.ts         also adds the Settings page and its command palette entry
```

Add `plugins/mcp/registry.ts` to `include` in `tsconfig.plugin-exports.json` and `tsconfig.web.json`. No alias changes: `@dia-plugin/*` is a wildcard in every tsconfig and in `vitest.config.ts`. `calls.ts` is not exported. Every export of `registry.ts` and `calls.ts` carries JSDoc, including `UserSource`, `PluginSource` and the guard.

## Interface

### `registry.ts` (`@dia-plugin/mcp/registry`)

```ts
/** The user added the server, through Settings. */
export const UserSource = Schema.TaggedStruct('User', {})
/** The plugin named `plugin` added the server. */
export const PluginSource = Schema.TaggedStruct('Plugin', { plugin: Schema.NonEmptyString })
/** Who added a server. Build one with `UserSource.make({})` or `PluginSource.make({ plugin })`. */
export const ServerSource = Schema.Union([UserSource, PluginSource])
export type ServerSource = typeof ServerSource.Type

/** One server the registry holds. */
export const RegisteredServer = Schema.Struct({
  name: Schema.String,
  server: McpServer,
  source: ServerSource
})
export type RegisteredServer = typeof RegisteredServer.Type

/** A registration or save used a name another source holds; `holder` is that source. */
export class McpServerNameTaken extends Schema.TaggedError<McpServerNameTaken>()(
  'McpServerNameTaken',
  { name: Schema.String, holder: ServerSource }
) {}

/**
 * Every MCP server dia knows, by name. Read it with `ctx.whenProvided([McpServerRegistryKey], …)`.
 */
export interface McpServerRegistry {
  /**
   * Adds `server` under `name` for plugin `plugin` (pass `ctx.name`) until the calling scope
   * closes. Call it inside `whenProvided`, so the server is removed when the caller or `mcp`
   * closes and added again when both are open. Fails when any source holds `name`. An uncaught
   * failure fails the whole `whenProvided` setup: its other registrations are removed and the
   * setup is not run again until `mcp` is provided again. To keep the other servers, catch
   * `McpServerNameTaken` for each server with `Effect.catchTag`.
   */
  readonly register: (
    name: string,
    server: McpServer,
    plugin: typeof PluginSource.Type['plugin']
  ) => Effect.Effect<void, McpServerNameTaken, Scope.Scope>
  /** The servers held now, ordered by name. */
  readonly list: Effect.Effect<ReadonlyArray<RegisteredServer>>
  /** The servers held now, then the whole list again after each change. */
  readonly changes: Stream.Stream<ReadonlyArray<RegisteredServer>>
}

const MEMBERS: Record<keyof McpServerRegistry, (member: unknown) => boolean> = {
  register: Predicate.isFunction,
  list: Effect.isEffect,
  changes: Stream.isStream
}

/** Whether `value` has every {@link McpServerRegistry} member. */
export const isMcpServerRegistry = (value: unknown): value is McpServerRegistry =>
  Object.entries(MEMBERS).every(
    ([member, check]) => Predicate.hasProperty(value, member) && check(value[member])
  )
/** The key `mcp` provides its {@link McpServerRegistry} under. */
export const McpServerRegistryKey = ServiceKey.make('mcpServerRegistry', isMcpServerRegistry)
```

### `calls.ts` (internal)

```ts
/** Streams every server the registry holds: the current list, then the list after each change. */
export const WatchServers = Rpc.make('WatchServers', {
  payload: {},
  success: Schema.Array(RegisteredServer),
  stream: true
})

/**
 * Replaces the user's servers with `servers`. Refused as a whole, with nothing saved, when a
 * plugin holds any name in `servers`.
 */
export const SaveUserServers = Rpc.make('SaveUserServers', {
  payload: { servers: McpServers },
  error: McpServerNameTaken
})
```

## Behaviour

| Case | Result |
|---|---|
| `register('github', s, 'gh-tools')`, no holder | `list` includes `{ name: 'github', source: Plugin('gh-tools') }`; `changes` emits |
| the scope `register` ran in closes | `github` is removed; `changes` emits |
| `register('github', …)` while the user holds `github` | fails `McpServerNameTaken { name: 'github', holder: User }`; the list is unchanged |
| that failure is not caught in the caller's `whenProvided` setup | the setup fails; its other registrations are removed; it runs again only when `mcp` is provided again (the user deleting `github` does not retry it) |
| `SaveUserServers({ github, linear })` while `gh-tools` holds `linear` | fails `McpServerNameTaken { name: 'linear', holder: Plugin('gh-tools') }`; neither the store nor the list changes |
| `SaveUserServers({ github })` while the user held `{ github, jira }` | the store holds `{ github }`; `jira` is removed from the list |
| `SaveUserServers` while the SQLite write fails | the call dies; the list and the store are unchanged |
| Host restart | `mcp`'s setup reads the store and holds every user server before it provides the key. No plugin can read the registry before the key is provided, so no plugin can claim a user's name first |
| `mcp` reloads | contributors' `whenProvided` scopes close, then run again against the new registry, and register again |

## Store

Migration `1_create_user_servers`:

```sql
CREATE TABLE user_servers (
  name   TEXT PRIMARY KEY,
  server TEXT NOT NULL   -- JSON of McpServer
)
```

The registry state is one `SubscriptionRef<ReadonlyMap<string, RegisteredServer>>`. `register`, the removal when its scope closes, and `replaceUser` each run as one `SubscriptionRef.modifyEffect`, whose semaphore (`SubscriptionRef.ts:871-937`) makes a name check and its map change one step. `register` is `Effect.acquireRelease(add, remove)`, each a `modifyEffect`. `list` reads the ref and sorts by name; `changes` is `SubscriptionRef.changes(ref).pipe(Stream.map(sortedList))`, which emits the current list first. `makeRegistry` builds every `RegisteredServer` source and every `holder` with `UserSource.make` and `PluginSource.make`.

`makeRegistry(initial)` returns the public `McpServerRegistry` and an internal `replaceUser(servers, persist)`, which is not on the exported interface. `persist` is `Effect<void>`: `host.ts` turns its SQL errors into defects with `Effect.orDie`, as `plugins/org/host.ts:93` does. `replaceUser` runs inside one `modifyEffect` and fails only with `McpServerNameTaken`, when a plugin holds any name in `servers`. Otherwise it runs `persist`, and only after `persist` succeeds replaces every `User` entry in the map; a `persist` defect leaves the map unchanged. A contributor's scope close waits for a running `persist`. At startup `host.ts` passes the stored servers to `makeRegistry(initial)`, which starts the map with them as `User` entries before the key is provided, so no plugin can hold one of their names first. On `SaveUserServers` it calls `replaceUser` with the payload and the transaction that replaces every row.

A row whose `server` fails to decode on startup is skipped with a logged warning.

## Settings page

`addEntry(ctx, SettingsPagesSlot, { id: 'mcp', label: 'MCP servers', … })` and a `CommandsSlot` entry `Settings › MCP servers`, as `plugins/meta/renderer.ts` does.

```
Your servers
  [McpServersEditor: JSON map of the user's servers]
  error text under the editor, e.g. "linear is provided by gh-tools"
                                                        [Save]
From plugins
  linear   http   gh-tools
```

`renderer.ts` creates `serversAtom = Atom.make(followHost(ctx, WatchServers, {}))` and passes it to the page, as `plugins/org/renderer.ts:17` does for `WatchWork`. While the atom is initial the page shows a skeleton; on failure it shows the failure text with a retry. `baseline` is the `mcpServersDraft` of the `User` servers in the latest list. `draft`, the text the editor shows, starts as the first `baseline`. When a new list changes `baseline` and `draft` equalled the old `baseline`, `draft` becomes the new `baseline`; otherwise `draft` stays. After a successful save the page sets `draft` to the `mcpServersDraft` of the servers it sent, because `readMcpServersDraft` fills defaults and drops unknown keys. Save is enabled when `draft` differs from `baseline`. Save runs `readMcpServersDraft(draft)`; on failure its message shows under the editor and no call is made. Otherwise the page runs `Effect.result(callHost(ctx, SaveUserServers, { servers }))`, as `plugins/org/org-actions.ts:65` does. `McpServerNameTaken` shows `<name> is provided by <plugin>`; `PluginNotServing` and `PluginCallInvalid` show their `message`; any other failure shows `Could not save the servers`. `mcp` writes this mapping itself, because `org`'s `commonFailureText` is not exported. A refused save keeps `draft`. The page imports `McpServersEditor` from `./servers-editor` directly; it is in the same plugin.

## Logging

`Effect.logInfo` when a server is registered or removed (name, source) and when user servers are saved (count). `Effect.logWarning` when a registration or a save is refused (name and holder) and when a stored row fails to decode.

## ADR change

ADR-0072 "Contribution contract": `Effect<void, never, Scope.Scope>` becomes `Effect<void, E, Scope.Scope>`, where `E` is the registry's name-taken error, and a later claim to a name fails.

## Tests

1. `registry`: a register adds the server with its source; closing the register's scope removes it; a second register of the name fails with the holder.
2. `host`: a test plugin whose setup registers `github` inside `whenProvided` shows `github` in `WatchServers`; unloading the test plugin removes it (criterion 1).
3. `host`: a harness that takes a database file in a temp directory (unlike `plugins/org/host.test.ts`, which hard-codes `':memory:'`) runs `SaveUserServers`, then unloads and loads `mcp` on that file; `WatchServers` lists the saved servers with source `User` (criterion 2).
4. `host`: `SaveUserServers` with a name a plugin holds fails and changes neither the list nor, after a reload, the store.
5. `host`: the `servers` payload of `SaveUserServers` reaches the store unchanged (CLAUDE.md RPC rule).
6. `settings-page`: renders plugin servers read-only; shows the `McpServerNameTaken` text under the editor; keeps an unsaved draft when a new list arrives.

Criterion 3 (the page in the app) is checked with `verify-in-app`.

## Design Rationale

**Source as a tagged union** — a reserved string such as `'user'` would collide with a plugin of that name. `ServerSource` makes the user and each plugin distinct values.

**`register` takes the plugin name** — dia's service objects do not know their caller, unlike `cordis`'s `this.ctx`. The caller passes `ctx.name`; plugins run in the Host process and are trusted, so the value is not checked.

**The user's servers are held before the key is provided** — no plugin can read the registry before `mcp` provides the key, and `mcp` provides it only after the user's servers are in the map. The order of plugin loads does not decide a clash between the user and a plugin.

**`replaceUser` is internal** — the user is not a plugin, so the user's servers cannot go through `register`, which records a `Plugin` source and ties each entry to a scope. Keeping `replaceUser` off the exported interface stops a plugin from writing the user's servers.

**`SaveUserServers` is all-or-nothing** — a partial save would leave the editor's text different from what is stored with no way to show which entries failed.

## Rejected Alternatives

**Keep both registrations and mark a conflict** — rejected by the user: a server could be listed and not used.

**Store user servers as registrations with a `'user'` string** — rejected: see "Source as a tagged union".

## Refinement Record

**Round 1**

Applied
- *Project rules (ADR-0059)* blocker: the spec did not add `registry.ts` to `tsconfig.plugin-exports.json` and `tsconfig.web.json`, which `plugin-exports.test.ts:103` requires.
- *Correctness* blocker: `McpServerRegistryKey` had no guard; now `ServiceKey.make` with `isMcpServerRegistry`, following `plugins/org/service.ts:92-116`.
- *Correctness* major: `register` and `SaveUserServers` could interleave a check and a change; now one `Semaphore` guards every check-and-change, and the map changes after the transaction commits.
- *Correctness* major: the user's servers had no path into the registry; now internal `replaceUser`.
- *Correctness* major: an uncaught `McpServerNameTaken` fails the caller's whole `whenProvided` setup; now stated in `register`'s JSDoc and in Behaviour.
- *Correctness* major: the restart rationale gave the wrong reason; now "no plugin can read the registry before the key is provided".
- *Correctness* major: the editor's rule for later lists was underspecified; now a `baseline`/`draft` rule.
- *Project rules* minor: added a test that the `servers` payload reaches the store unchanged.
- *Correctness* minor: cited `plugin-registry.ts` for `whenProvided`'s implementation beside the contract.

**Round 2**

Applied
- *Project rules (CLAUDE.md, tagged values)* major: `ServerSource` held anonymous `TaggedStruct`s with no `.make`; now named `UserSource` and `PluginSource`.
- *Minimize complexity* major: a second `Semaphore` duplicated the one in `SubscriptionRef`; now every check-and-change is one `SubscriptionRef.modifyEffect`, and `register` is `Effect.acquireRelease`.
- *Correctness* major: the restart test used the org harness's `':memory:'` database; now a temp-directory file.
- *Correctness* major: the draft rule left the page unsaved after a save, because `readMcpServersDraft` normalizes text; now the page sets `draft` from the sent servers, and the atom's initial and failure states are specified.
- *Define Errors Out of Existence* minor: `RegisteredServer.name` was `NonEmptyString` while `McpServers` keys are `String`, so a saved `""` key could not be streamed; now `Schema.String`.
- *Project rules (no comments)* minor: the `MEMBERS` comment became the table.
- *Logging* minor: a refused save is logged with its holder.

**Round 3**

Applied
- *Correctness* major: `replaceUser`'s SQL failure had no channel that `SaveUserServers` (error `McpServerNameTaken`) could carry; `persist` now dies on SQL errors with `Effect.orDie`, following `plugins/org/host.ts:93`, and the startup call dies on the impossible `McpServerNameTaken`.
- *Correctness* minor: the renderer's save and its failure text were unspecified; now `readMcpServersDraft` first, then `Effect.result(callHost(...))` with a mapping `mcp` owns.
- *Consistency* minor: `register`'s `plugin` parameter now has `PluginSource`'s `plugin` type.

No blocker or major finding remains standing.

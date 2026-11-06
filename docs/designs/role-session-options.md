# Role session options and start permission mode (#176)

Scope: method/class. Lets the Host open an agent session with a role's permission rules and MCP servers, and picks the permission mode a hired agent session starts in (ADR-0054, "Mode at session start"). No caller passes a role yet (#179 will); ad-hoc tabs keep their current SDK options. Out of scope: the router's `dontAsk` start mode (ADR-0054; plan step 2), gathering `startPermissionMode`'s inputs and resolving a hire's bypass override over its role's (#177, #179).

## Interface

### `src/shared/domain/role-session.ts` (platform-neutral, ADR-0013)

```ts
/**
 * A stdio, http or sse MCP server a role adds to its sessions; a subset of the Agent SDK's
 * `McpServerConfig`. `args`, `env` and `headers` are required; empty means none.
 */
export const RoleMcpServer = Schema.Union([
  Schema.Struct({ type: Schema.Literal('stdio'), command: Schema.String, args: Schema.Array(Schema.String), env: Schema.Record(Schema.String, Schema.String) }),
  Schema.Struct({ type: Schema.Literal('http'), url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
  Schema.Struct({ type: Schema.Literal('sse'), url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) })
])
export type RoleMcpServer = typeof RoleMcpServer.Type

/**
 * Permission rules in Claude Code rule syntax (`Bash(git push *)`, `Read`, `mcp__github`).
 * `allow` approves a matching call, `ask` always asks the user, `deny` blocks it in every mode.
 * All empty means the role adds no rules.
 */
export const PermissionRules = Schema.Struct({
  allow: Schema.Array(Schema.String),
  ask: Schema.Array(Schema.String),
  deny: Schema.Array(Schema.String)
})
export type PermissionRules = typeof PermissionRules.Type

/** What a role adds to a session: its permission rules, and MCP servers keyed by server name. */
export const RoleSessionOptions = Schema.Struct({
  permissions: PermissionRules,
  mcpServers: Schema.Record(Schema.String, RoleMcpServer)
})
export type RoleSessionOptions = typeof RoleSessionOptions.Type
```

### `src/host/session/agent-backend.ts`

```ts
export interface AgentSessionOptions extends SessionAdditions {
  ...existing fields
  readonly role: Option.Option<RoleSessionOptions>
}
```

The interface's JSDoc gains: "`role` is the role the session runs as, or none for an ad-hoc tab." Its existing sentence about the session's whole life covers both the {@link SessionAdditions} and `role`.

`SessionFactoryLive.start` (`src/host/services/pane-supervisor.ts`) and every other construction of `AgentSessionOptions` (the fixtures in `session-queue.test.ts`, `session-rewind.test.ts`, `session-context-usage.test.ts`, and any in `agent-backend.test.ts` and `meta-repo-seam.test.ts`) pass `role: Option.none()`. `src/host/plugin-api.ts` adds `type RoleSessionOptions` to its type re-exports next to `SessionAdditions`.

### `src/host/session/start-permission-mode.ts`

```ts
/** A mode {@link startPermissionMode} can return. */
export type HiredStartMode = Extract<PermissionMode, 'auto' | 'bypassPermissions' | 'default'>

/**
 * The permission mode a hired agent session starts in, by ADR-0054's "Mode at session start"
 * table. `modelSupportsAuto` is the session model's `ModelOption.autoMode`; `disabled` is
 * `AgentBackend.disabledPermissionModes(cwd)` for the session's cwd; `bypassOptedIn` is whether
 * the hire, or its role when the hire does not override it, opts into bypass. Not for router
 * sessions or ad-hoc tabs. Pure and does not log; its caller logs the inputs and the result.
 */
export const startPermissionMode = (input: {
  readonly modelSupportsAuto: boolean
  readonly disabled: ReadonlyArray<PermissionMode>
  readonly bypassOptedIn: boolean
}): HiredStartMode
```

Rows, first match wins: `auto` when `modelSupportsAuto && !disabled.includes('auto')`; `bypassPermissions` when `bypassOptedIn && !disabled.includes('bypassPermissions')`; else `default`.

### `plugins/claude-code/session-tool-options.ts`

```ts
/**
 * The Agent SDK query options that decide which tools a session has and how their calls are
 * approved: dia's task-tracking tools and `role`'s allow rules as `allowedTools`, its deny rules
 * as `disallowedTools`, its ask rules as `settings.permissions.ask`, and its MCP servers plus
 * `diaToolServer` (under `DIA_TOOL_SERVER_KEY`) as `mcpServers`. Keys with nothing to set are
 * omitted. Spread the result into a query's `options`.
 */
export const sessionToolOptions = (
  role: Option.Option<RoleSessionOptions>,
  diaToolServer: Option.Option<McpSdkServerConfigWithInstance>
): Pick<Options, 'allowedTools' | 'disallowedTools' | 'settings' | 'mcpServers'>
```

`none` is read as a role with empty rules and no servers, so there is one code path.

| Input | Output |
| --- | --- |
| role none, no dia server | `{ allowedTools: [...TASK_TRACKING_TOOLS] }` (today's ad-hoc options) |
| role none, dia server | `{ allowedTools: [...TASK_TRACKING_TOOLS], mcpServers: { [DIA_TOOL_SERVER_KEY]: server } }` (today's) |
| role some | `allowedTools: [...TASK_TRACKING_TOOLS, ...allow]`; `disallowedTools: [...deny]` when non-empty; `settings: { permissions: { ask: [...ask] } }` when non-empty; `mcpServers: { ...role servers with stdio args copied to mutable arrays, [DIA_TOOL_SERVER_KEY]: server }` when non-empty |

A role server named `DIA_TOOL_SERVER_KEY` is replaced only when `diaToolServer` is `some`, and kept otherwise; `runSession` logs a warning when both hold.

`TASK_TRACKING_TOOLS` moves from `session.ts` to `session-tool-options.ts` and is exported with JSDoc; `session-rewind.test.ts` imports it in place of its copy.

`runSession` (`plugins/claude-code/session.ts`) takes `role` beside `additions`, so a restart builds the same options; it is appended after `additions` in the existing positional style (folding the parameters into one object is out of scope). It replaces its `allowedTools: TASK_TRACKING_TOOLS` and `mcpServers` spread with `...sessionToolOptions(role, Option.map(newDiaToolServer, (make) => make()))`, and its `Starting query session` log replaces `allowedTools: TASK_TRACKING_TOOLS` with the role's allow, ask and deny rules and MCP server names, read from `role` without building the dia tool server. `sessionToolOptions` is called once, inside the `Effect.sync` that opens the query, as the server factory is today.

## Design Rationale

**Ask rules go through `settings.permissions.ask`**: the SDK has no `askTools` option. `Options.settings` (sdk.d.ts:2272, `settings?: string | Settings`) is the only per-query way to pass ask rules. Allow and deny use the documented `allowedTools` and `disallowedTools`.

**One function builds the tool options**: `allowedTools` and `mcpServers` each combine dia's own entries with the role's, so a single function owns both merges and no later spread overwrites an earlier one.

**`role` is an `Option`**: ADR-0033 separates ad-hoc tabs from hired agents, and the session options state which one a session is. `sessionToolOptions` reads `none` as an empty role, so the two cases cannot produce different SDK options for the same rules.

**Copy arrays at the SDK boundary**: schema arrays are `ReadonlyArray`; the SDK declares `string[]`. Copying keeps the shared schema immutable.

**Instructions stay in `systemPromptAppend`**: the meta repo's additions already use it. #179 appends the role's instructions to them, and the adapter already sends `systemPromptAppend` on every restart.

**`startPermissionMode` is in the Host and is pure**: ADR-0054 says the Host picks the mode at session start. Plain inputs make each ADR row one test; #179 gathers the inputs (`ModelCatalogFeed`, `AgentBackend.disabledPermissionModes`, the hire) and logs.

**`startPermissionMode` ships before its caller**: #179 needs it, and ADR-0054's rows are testable now.

**Schemas in `src/shared`**: #177's role schema embeds `PermissionRules` and `RoleMcpServer`.

## Live probe (not committed)

A script runs the installed SDK in `permissionMode: 'auto'` in a temp git repo, with `settings: { permissions: { ask: ['Bash(git status*)'] } }` and a `canUseTool` that logs and allows. Prompt 1: run `git status`. Prompt 2: a call the classifier blocks (force-push to a fake remote). Record whether `canUseTool` fired for each. Then update ADR-0054's two markers and add a `docs/reasoning/` entry.

## Tests

- `start-permission-mode.test.ts`: one case per ADR-0054 row; plus auto supported but disabled with opt-in → `bypassPermissions`; auto disabled and bypass disabled with opt-in → `default`.
- `session-tool-options.test.ts`: role none with and without the dia server gives today's options; each role mapping; empty role lists omit keys; a role server named `DIA_TOOL_SERVER_KEY` is replaced.
- `session-queue.test.ts`: a session opened with a role passes the rules and servers to the first query and to the query after a restart.
- Type level: `RoleMcpServer` copied for the SDK satisfies the SDK's `McpServerConfig` (typecheck).

## Refinement Record

**Round 1**

Applied
- *Correctness, B1*: readonly schema arrays are not assignable to the SDK's `string[]`, so they are now copied at the boundary.
- *Correctness, B2* and *Temporal Decomposition, D1*: the `mcpServers` merge was split across two places and dropped role servers without a dia server. One function, `sessionToolOptions`, now owns the merge.
- *Correctness, M1*: the doc said "the shape the SDK accepts", but the schema is a subset; required `args`/`env`/`headers` are now stated.
- *Correctness, M2*: the start log shows the merged values.
- *Project rules, P1*: `HiredStartMode` is now derived from `PermissionMode`.
- *Project rules, P3*: the doc states that `startPermissionMode` does not log and its caller logs.
- *Project rules, P4*: the schema is renamed `RoleMcpServer`, so it no longer shares a name with the SDK's `McpServerConfig`; the re-export is stated.
- *Names as Documentation, D3*: `bypassOptIn` is renamed `bypassOptedIn`, and the caller resolves the hire-over-role precedence.
- *D4*: the instructions rationale now states its reason.
- *Scope*: the router's `dontAsk` mode is marked out of scope.

Rejected
- *Project rules, P2* (JSDoc on `export type X = typeof X.Type`): `src/shared/domain/pane.ts` documents the schema constant and leaves the derived type alias without its own JSDoc; this spec follows that pattern.
- *AHA, D2* (drop the `Option`): the `Option` records ADR-0033's ad-hoc versus hired distinction; reading `none` as an empty role in one code path removes the drift the finding describes.

**Round 2**

Applied
- *Correctness, M1*: every construction of `AgentSessionOptions`, test fixtures included, now passes `role`.
- *Correctness, M2*: `TASK_TRACKING_TOOLS` was private to `session.ts`; it moves to `session-tool-options.ts`.
- *m1*: a role server that `DIA_TOOL_SERVER_KEY` replaces is logged.
- *m2*: rationale for shipping `startPermissionMode` before its caller.
- *m3*: `role` follows the existing positional-parameter style; refactoring `runSession`'s parameters is out of scope.

**Round 3**

Applied
- *Correctness, F2*: the `DIA_TOOL_SERVER_KEY` replacement and its warning apply only when the dia tool server is present.
- *Correctness, F3*: the start log reads the role directly, so the dia tool server is still built once per query, inside the query's `acquireRelease`.

Rejected
- *Correctness, F1* (rule syntax in `allowedTools`/`disallowedTools` unverified): the Agent SDK permissions page (https://code.claude.com/docs/en/agent-sdk/permissions.md) documents `disallowed_tools=["Bash(rm *)"]` as "Calls matching `rm *` are denied in every permission mode, including `bypassPermissions`", and states that `allowed_tools` and `disallowed_tools` add entries to the allow and deny rule lists.
- *Speculative generality, F4*: already covered by the "ships before its caller" rationale; the finding itself does not block.

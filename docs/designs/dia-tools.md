# `dia-tools` plugin

Issue: draekien/dia#244, step 6 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0075.

`dia-tools` holds the registry of dia tools and serves it over MCP. A plugin registers a tool once, with a predicate over `ToolScope`; every MCP client whose token carries a matching scope lists and calls it. `dia-runs` issues one token per run and gives each session one MCP server named `dia` of type `http`. An agent outside dia connects through the `dia-mcp` stdio command with a token the user creates from the command palette.

It replaces `AgentSessionOptions.diaTools`, the string-only `DiaToolField`, and `plugins/dia-claude-code/tool-server.ts`.

## Success criteria

1. A plugin registers a Schema-typed tool; a run whose `ToolScope` matches lists and calls it over HTTP, and the handler receives the run's `context`. (Test: `plugins/dia-tools/http-server.test.ts` connects an MCP SDK client with a granted token and calls the tool; the handler records `scope.context`.)
2. A call without a token, with a revoked token, or with an `Origin` header is refused. (Test: the same file, `401`, `401` and `403`.)
3. `plugin_*` tools are listed for a run's token and absent for an outside token. (Test: `plugins/dia-runs/run-tools.test.ts` registers the kernel's tools through `registerPluginTools` and compares `forScope` for a run scope and an outside scope; app: a tab's agent calls `mcp__dia__plugin_reload`.)
4. `DIA_MCP_TOKEN=<token> dia-mcp <endpoint file>`, configured as a stdio server in Claude Code in a terminal, lists the tools. (Test: `plugins/dia-tools/dia-mcp.test.ts` spawns the command and lists over stdio; app: `claude mcp add` with the copied command, then `/mcp`.)
5. A registry change sends `notifications/tools/list_changed` to connected sessions. (Test: an MCP client's `ToolListChangedNotification` handler fires after a second `register`.)

## Decisions taken without the user

D1. **An agent outside dia obtains a token from the command palette.** The command "Connect an outside agent to dia tools" calls `IssueOutsideToken` on `dia-tools`, which creates a random token, stores its SHA-256 hash in `<dataDir>/outside-tokens.json`, and returns a complete `claude mcp add` command line (token, `ELECTRON_RUN_AS_NODE=1`, dia's executable, the `dia-mcp` script and the endpoint file). The renderer copies the line to the clipboard and shows a toast. "Revoke outside agents' dia tool tokens" calls `RevokeOutsideTokens`. Outside tokens are persisted (hashes only), because a terminal configuration outlives a dia restart; run tokens stay in memory as ADR-0075 says. Alternatives: a settings page listing tokens (more UI for one action); a token file `dia-mcp` reads when `DIA_MCP_TOKEN` is unset (stores the token in plaintext and contradicts ADR-0075's environment variable).

D2. **The registry contract lives in `dia-tools`' exported module `tools.ts` (`@dia-plugin/dia-tools/tools`)**, because only plugins use it (root `CLAUDE.md`). `DiaTool`, `DiaToolResult` and `ToolScope` stay in the kernel (`src/host/session/dia-tools.ts`, exported from `@dia/plugin`), because the kernel builds the `plugin_*` tools.

D3. **`dia-runs` registers the kernel's `plugin_*` tools.** The kernel still builds them (`ctx.pluginTools`); `dia-runs`, the plugin that runs the sessions, registers them with `when: isRunScope`, and a tool's `turnEnded` is `Runs.awaitIdle(scope.runId)`. ADR-0075 says "the kernel registers"; the kernel cannot read a plugin's key, and `dia-runs` already owns `turnEnded`. Alternative: a kernel seam key for the registry, which moves a plugin-only contract into `src/`.

D4. **Protocol code comes from `@modelcontextprotocol/sdk` 1.32.2**, already installed as the Agent SDK's dependency; it is now declared in `package.json` at that version, because `dia-tools` and `dia-mcp` import it. It provides the Streamable HTTP and HTTP+SSE server transports, the stdio and Streamable HTTP client transports `dia-mcp` pipes together, and the `McpServer` instance the Agent SDK takes in-process. Effect's `effect/ai/McpServer` was rejected: it serves one tool set to every client, with no per-token listing, and has no HTTP+SSE transport.

D5. **SSE means the HTTP+SSE transport of protocol revision 2024-11-05** (`GET /sse`, `POST /messages?sessionId=`), served by the same HTTP server. The 2025-03-26 revision replaced it with Streamable HTTP; clients that only speak the old transport still connect.

D6. **Only a request with no `Origin` header is accepted.** ADR-0075 also allows a dia renderer origin; no renderer code calls `/mcp`, so none is allowed until one does.

D7. **`dia-mcp` takes the endpoint file path as its first argument** rather than finding the variant's user data folder itself. dia writes the path into the command it hands out, so `dia-mcp` needs no knowledge of `dia`, `dia-dev` and `dia-nightly`. It is built by electron-vite as `out/main/dia-mcp.js` and runs under dia's own executable with `ELECTRON_RUN_AS_NODE=1`, which reads `app.asar` in a packaged build.

D8. **A run's `ToolScope` is `{ runId, project: sourceCwd, labels, context }`.** `labels` and `context` are optional fields of `StartRunOptions` and `RunSpec`, stored in the run's row so recovery restores them; `context` must be JSON-serialisable. A tab's run has no labels and no context.

D9a. **`dia-tools` finds the `dia-mcp` script with `import.meta.resolve('@dia/plugin')`**, which the loader's resolve hook maps to `out/main/plugin-api.js`; `dia-mcp.js` is its sibling. A kernel export of the path was rejected because `@dia/plugin` is also type-checked as a platform-neutral module (`tsconfig.plugin-exports.json`), where `import.meta.url` does not exist.

D9. **A reload of `dia-tools` from a `plugin_reload` call ends that HTTP request**, so the agent sees a failed call although the reload completes. Deferring it as for `dia-runs` needs the kernel to name a second plugin; recorded, not handled.

## Interface

### Kernel (`src/host/session/dia-tools.ts`, re-exported from `@dia/plugin`)

```ts
/** Who a tool call comes from: a dia run (`runId` set) or an outside agent (no `runId`). */
export const ToolScope = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  labels: Schema.Array(Schema.String),
  context: Schema.Unknown
})
export type ToolScope = typeof ToolScope.Type

/** Input schema a tool may declare: decodes with no services. */
export type ToolInput = Schema.Top & { readonly DecodingServices: never }

export interface DiaTool<S extends ToolInput = ToolInput> {
  readonly name: string
  readonly description: string
  readonly input: S                        // a Schema.Struct; its JSON Schema is the MCP inputSchema
  run(input: S['Type'], scope: ToolScope): Effect<DiaToolResult>
}
export const diaTool: <S extends ToolInput>(tool: DiaTool<S>) => DiaTool<S>   // infers S
export const isRunScope: (scope: ToolScope) => boolean
```

`ctx.pluginTools(turnEnded: (runId: string) => Effect<void>): ReadonlyArray<DiaTool>`.

### Registry contract (`plugins/dia-tools/tools.ts`, exported)

```ts
export interface Tools {
  /** Offers `tool` to every scope `when` accepts until the calling scope closes. */
  readonly register: (tool: DiaTool, options: { when: (scope: ToolScope) => boolean }) => Effect<void, never, Scope>
  /** The tools `scope` lists, by name. */
  readonly forScope: (scope: ToolScope) => Effect<ReadonlyArray<DiaTool>>
  /** Accepts the token hashing to `tokenHash` as `scope` until `revoke`. */
  readonly grant: (tokenHash: string, scope: ToolScope) => Effect<void>
  /** Refuses the token from now on and closes its MCP sessions. */
  readonly revoke: (tokenHash: string) => Effect<void>
  /** The Streamable HTTP URL (`http://127.0.0.1:<port>/mcp`). */
  readonly url: string
  /** A new in-process MCP SDK `McpServer` for `scope`, typed `object` (an exported module cannot import the MCP SDK). */
  readonly mcpServer: (scope: ToolScope) => Effect<object>
}
export const ToolsKey: ServiceKey<Tools>
export const newToken: Effect<{ token: string; hash: string }, never, Crypto>
export const hashToken: (token: string) => Effect<string, never, Crypto>
```

### Plugin (`plugins/dia-tools`)

- `plugin.json`: `name: dia-tools`, `category: feature`, `host: host.ts`, `renderer: renderer.ts`, `load: eager`, `exports: ["tools.ts", "calls.ts"]`.
- `registry.ts`: registered tools, granted hashes, and a change stream.
- `mcp-server.ts`: one `McpServer` per MCP session over the registry: `tools/list` returns `forScope`, `tools/call` decodes the arguments with the tool's schema (a decode failure is an `isError` result) and runs it; logs each call.
- `http-server.ts`: `node:http` on `127.0.0.1`; checks `Origin` then `Authorization: Bearer` on every request; `/mcp` Streamable HTTP with sessions bound to the token hash that opened them; `/sse` and `/messages` HTTP+SSE. Sends `notifications/tools/list_changed` to every session on a registry change.
- `outside-tokens.ts`: the persisted outside token hashes.
- `host.ts`: reads the port from `<dataDir>/endpoint.json` (0 the first time), listens, writes the port back, provides `ToolsKey`, serves `IssueOutsideToken` and `RevokeOutsideTokens`.
- `dia-mcp.ts`: the stdio command, a pipe between `StdioServerTransport` and `StreamableHTTPClientTransport`.
- `renderer.ts`: the two command palette commands.

### `dia-runs`

- `run-tools.ts`: keeps each live run's token hash and scope, grants them to every `Tools` provider as it appears, revokes a run's token when the run's scope closes, and registers the `plugin_*` tools.
- A run opens its session with `tools: Some({ permissions: empty, mcpServers: { dia: { type: 'http', url, headers: { Authorization } } }, skills: [] })`, or `None` when no `Tools` provider is loaded.

### Other changes

- `AgentSessionOptions.diaTools` and `plugins/dia-claude-code/tool-server.ts` are removed; `sessionToolOptions` takes only `tools`.
- `dia-issues`: tool inputs are `Schema.Struct`s; `issueTools` is a list (no arguments) whose handlers read `IssueToolContext` (`{ issueId, assigneeId }`) from `scope.context`. The plugin that starts issue runs registers them (org rewrite).
- `PLUGIN_API_VERSION` goes up; `DiaRpcs` is unchanged.

## Refinement Record

Round 1 (inline, user unavailable):

**Applied**
- *Define Errors Out of Existence, major* — `grant` with a raw token let `dia-tools` hold secrets; it takes the hash, and `newToken` returns both.
- *Correctness, major* — a Streamable HTTP session opened with one token could be continued with another granted token; sessions are bound to the opening hash and a mismatch is refused.
- *Correctness, major* — run tokens would leak MCP sessions per run; `revoke` closes the token's sessions.

**Rejected**
- *Information Hiding, minor, `url` exposes the transport* — the caller must put a URL in the session's MCP config; it is the module's product, not a detail.
- *Strategic Programming, minor, `mcpServer` has no caller* — ADR-0075 requires the in-process transport; it is the same factory the HTTP transport uses.

---
status: accepted
date: 2026-11-13
decision-makers: William Pei
---

# A `dia-tools` plugin holds the registry of dia tools and serves it over stdio, HTTP, SSE and the in-process SDK transport

## Context and Problem Statement

A dia tool reaches an agent only through the caller that opens the session. `AgentSessionOptions.diaTools` (`src/host/session/agent-backend.ts`) carries the list, tabs always pass the three `plugin_*` tools (`src/host/session/dia-tools.ts`), and `plugins/claude-code/tool-server.ts` turns the list into an in-process SDK MCP server named `dia`. `plugins/issues/issue-tools.ts` reaches only the sessions the org plugin opens, bound to one issue and hire per session (`runs.issueTools(issue.id, hire.id)` in `plugins/org/dispatcher.ts`). Every `DiaTool` input field is a string matched by a regular expression. t3code serves its tools from one HTTP MCP server with a credential per session (`apps/server/src/mcp/McpHttpServer.ts`, `McpSessionRegistry.ts`); deepseek-harness lets any plugin call `ctx.tools.register(defineTool(...))`. How should a plugin give a tool to runs, and how should agents reach it?

## Decision Drivers

* Any plugin can give a tool to the runs it chooses, without opening the session.
* A tool handler knows which run, and which caller-defined context (for example an issue and a hire), a call belongs to.
* Tool inputs are typed by Effect Schema.
* Agents that dia does not start, and adapters other than `dia-claude-code`, can call dia tools.
* No local process other than an authorised agent can call a dia tool.

## Considered Options

* A `dia-tools` registry plugin served over stdio, HTTP, SSE and the in-process SDK transport, with dia's runs on HTTP
* A `dia-tools` registry plugin served only in-process by `dia-claude-code`
* A `dia-tools` registry plugin served only over HTTP

## Decision Outcome

Chosen option: "A `dia-tools` registry plugin served over stdio, HTTP, SSE and the in-process SDK transport, with dia's runs on HTTP", because one registry then serves dia's runs and outside agents.

Registry:

* `dia-tools` provides `ToolsKey`: `register(tool, { when })` and `forScope(scope)`. `when` is a predicate over `ToolScope`, a schema `dia-tools` defines: run id, project, labels, and `context`, a value of type `unknown` that the caller who starts the run supplies and the tool handler receives (ADR-0066). `dia-tools` imports nothing from `dia-runs`.
* A tool declares its input as an Effect Schema. The `DiaTool` type and its string-only `DiaToolField` are replaced. `AgentSessionOptions.diaTools` is removed.
* The kernel registers the three `plugin_*` tools (ADR-0074). Their `when` excludes scopes issued to agents outside dia.
* When the registry changes, every connected MCP session receives `notifications/tools/list_changed`.

Transports, all serving one MCP request handler (`tools/list`, `tools/call`):

* HTTP: bound to `127.0.0.1`, path `/mcp`. A request needs `Authorization: Bearer <token>`. A request with an `Origin` header that is not absent or a dia renderer origin is refused.
* SSE: the same server.
* stdio: a `dia-mcp` command that an agent spawns. It reads its token from the `DIA_MCP_TOKEN` environment variable, reads the port from a file in the user data folder of the dia variant (`dia`, `dia-dev`, `dia-nightly`), and forwards stdin and stdout JSON-RPC to the HTTP endpoint.
* In-process: `createSdkMcpServer` from the Agent SDK, for a caller that wants no port.

Tokens and runs:

* `dia-runs` issues one token per run and registers the token's SHA-256 hash and the run's `ToolScope` with `dia-tools`. `dia-tools` keeps hashes in memory only. `dia-runs` revokes a run's token when the run ends. When `dia-tools` reloads, `dia-runs` registers the hashes of its live runs again.
* A run that dia starts gets one MCP server `dia` of type `http` with its run's token in `headers` (`McpHttpServerConfig`, `@anthropic-ai/claude-agent-sdk` `sdk.d.ts`). Tool names stay `mcp__dia__<tool>`, so the session's permission rules and `canUseTool` apply unchanged (ADR-0069).
* `dia-tools` keeps its HTTP port across its own reload, stored in its data folder.
* `plugins/mcp`, which configures external servers that agents connect to, is unrelated.

### Consequences

* Good, because `dia-issues` and `dia-runs` register tools once and every matching run receives them, with the context each call belongs to.
* Good, because agents outside dia reach the same tools through stdio or HTTP.
* Bad, because dia listens on a local port and checks a token and `Origin` on every call.
* Bad, because four transports need tests, and SSE and the in-process transport have no consumer when they are built.

## Pros and Cons of the Options

### A `dia-tools` registry plugin served only in-process by `dia-claude-code`

* Good, because it moves existing code and opens no port.
* Bad, because a server is fixed for its `query()`, so a tool change reaches a running agent only if the server is rebuilt.
* Bad, because only Agent SDK sessions can call the tools.

### A `dia-tools` registry plugin served only over HTTP

* Good, because one transport is tested.
* Bad, because an agent configured with a command (stdio) cannot connect.

## More Information

* The MCP specification revision of 2025-03-26 replaced the HTTP+SSE transport with Streamable HTTP. <!-- unverified: not checked against modelcontextprotocol.io at time of writing -->
* Whether Claude Code refetches `tools/list` on `notifications/tools/list_changed` from an HTTP server. <!-- unverified -->
* Open at design time for the `dia-tools` step of `docs/plans/2026-11-13-foundation.md`: how an agent outside dia obtains a token.
* Amends ADR-0019 (kernel MCP server per pane) and ADR-0069 (dia tools follow the session's permission rules; the transport changes, the rule does not).

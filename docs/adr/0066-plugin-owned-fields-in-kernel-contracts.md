---
status: "accepted"
date: 2026-11-08
decision-makers: William Pei
---

# A kernel contract field whose shape a plugin owns is `unknown` in the kernel

## Context and Problem Statement

`SessionToolOptions` (`src/shared/domain/session-tools.ts`) is a kernel contract: the Host builds it and passes it to the plugin that provides `agentBackend`. Its `mcpServers` field held `McpServer` values whose schema lived in the kernel and was exported from `@dia/plugin`. Only plugins read or write an MCP server: `org` stores one per job title and `claude-code` passes it to the Agent SDK. ADR-0062 places a contract that only plugins use in an exported module of the plugin that owns it. Where does the schema of a field go when the field sits inside a kernel contract?

## Decision Drivers

* MCP server configuration changes with the `mcp` plugin (issue #197 replaces its editor), and a kernel change needs an app release and a `PLUGIN_API_VERSION` bump.
* `claude-code` can import another plugin's export (ADR-0065).

## Considered Options

* The field is `unknown` in the kernel; the owning plugin exports the schema; the reader decodes the field with it
* The kernel keeps the schema and re-exports it from `@dia/plugin`

## Decision Outcome

Chosen option: "The field is `unknown` in the kernel", because it applies ADR-0062's rule to a field inside a kernel contract (user decision, 2026-11-07). The design is `docs/designs/mcp-plugin.md`.

| Rule | Value |
|---|---|
| Kernel type | `SessionToolOptions.mcpServers: Record<string, unknown>`. The kernel copies the values and does not read them |
| Owner | `plugins/mcp` exports `McpServer` and `McpServers` from `@dia-plugin/mcp/servers` |
| Writer | `org` stores job title servers decoded with `McpServers` |
| Reader | `claude-code` decodes each entry with `McpServer`. An entry that fails is left out of the session and logged with `An MCP server was left out of the session` |

### Consequences

* Good, because a change to the MCP server shape changes only `plugins/mcp` and its importers, which reload with it (ADR-0059).
* Good, because `@dia/plugin` no longer exports `McpServer`.
* Bad, because the kernel type no longer rejects a malformed server; the reader must decode, and a server it cannot decode is dropped with only a log line to show it.

## Pros and Cons of the Options

### The field is `unknown` in the kernel

* Good, because the kernel holds no schema it does not use.
* Bad, because each reader decodes the field again.

### The kernel keeps the schema

* Good, because the type is checked where the contract is built.
* Bad, because every change to the shape is a kernel change and a `PLUGIN_API_VERSION` bump.

## More Information

* Supersedes the `McpServer` location stated in `docs/designs/org-job-titles.md`.

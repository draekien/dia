---
status: "accepted"
date: 2026-11-07
decision-makers: William Pei
---

# Adapter plugins load, reload, unload and import under the same rules as feature plugins

## Context and Problem Statement

ADR-0029 made `plugins/claude-code` an `adapter` plugin. An adapter loaded once, only from the shipped copy. It could not be reloaded, unloaded or overridden. It could not declare `inject`, call `whenProvided` or import another plugin's export (ADR-0059). Only an adapter could provide `agentBackend` (ADR-0062). These rules stop claude-code from importing an `mcp` plugin's export, and every change to claude-code needs an app restart. deepseek-harness registers its LLM adapters from ordinary plugins (`packages/llm/llm-deepseek-api-key/src/index.ts:17`). Should dia's adapters follow the same rules as every other plugin?

## Decision Drivers

* claude-code imports contracts that other plugins own, such as MCP server configuration, through ADR-0059 exports.
* A change to claude-code applies through a reload, the same as a change to any other plugin.
* A running agent turn is not interrupted by a reload (ADR-0019).

## Considered Options

* Adapters are ordinary plugins; `category` is a label
* An adapter keeps the module it loaded at startup, and only the export-import ban is lifted

## Decision Outcome

Chosen option: "Adapters are ordinary plugins; `category` is a label", because it matches deepseek-harness and removes every rule that branches on `category` (user decision, 2026-11-07). The design is `docs/designs/adapters-as-ordinary-plugins.md`.

| Rule | Value |
| --- | --- |
| Manifest | One `PluginManifest` struct. `category` is `feature` or `adapter`; `host`, `renderer`, `inject`, `exports` and `load` mean the same for both. An adapter manifest may omit `host` |
| Startup | `load: "eager"` decides, as for any plugin. `plugins/claude-code/plugin.json` declares it |
| Load, reload, unload, worktree override | Allowed for an adapter |
| `inject`, `whenProvided`, imports of `@dia-plugin/*` exports | Allowed for an adapter |
| `agentBackend` | Any plugin may provide it. A second provider fails with `ServiceKeyTakenError` |
| Running sessions | A session opened before a reload keeps the adapter code it opened with until it ends. `AgentBackend.openSession` runs the session in the caller's scope, so closing the plugin scope does not end it. Sessions opened after the reload use the new backend |
| Reading the backend | `resolveAgentBackend` reads with `inject` once per session or operation. A `use` lease is rejected: it ends when `openSession` returns, so it would not cover the session |
| `category` readers | The Adapters settings page and model preferences |

This ADR supersedes ADR-0029's category rules: the "Hot reload", "Worktree override" and "Can be unloaded" columns, the adapter contract and the `inject` ban. ADR-0029's decision to put the Agent SDK behind one adapter interface stays. It amends ADR-0019, ADR-0027, ADR-0055, ADR-0056, ADR-0059, ADR-0062 and ADR-0063 where they state an adapter rule.

### Consequences

* Good, because claude-code can import another plugin's export, and a change to claude-code applies through a reload.
* Good, because the registry, plugin sources, plugin modules and the plugin settings page have no adapter branch.
* Bad, because a worktree override of claude-code, or any plugin that provides `agentBackend`, answers `canUseTool`. The guarantee from ADR-0028 and ADR-0029 that only the shipped adapter answers permission prompts no longer holds.
* Bad, because a plugin that provides nothing under `agentBackend` loads without error. The adapter contract's load failure, which listed each missing method, is gone. A provided value that is not an `AgentBackend` still reads as not provided, and the registry logs `A provided service failed its key check` (ADR-0062).
* Bad, because a pane opened while claude-code reloads ends with `The claude-code adapter is not loaded`.
* Bad, because each reload keeps the old module loaded while a session opened on it runs. That memory counts toward the plugin's reload limit, after which a reload reports `RestartRequired`.
* Bad, because `ServiceKeyReservedError` is removed from `ctx.provide`, so `PLUGIN_API_VERSION` goes from 0.0.28 to 0.0.29.

## Pros and Cons of the Options

### Adapters are ordinary plugins; `category` is a label

* Good, because one set of plugin rules applies to every plugin.
* Bad, because the permission-prompt guarantee is lost.

### An adapter keeps the module it loaded at startup, and only the export-import ban is lifted

* Good, because the permission-prompt guarantee holds.
* Bad, because an exporter reload leaves claude-code on the old export until a restart, and a change to claude-code still needs a restart.

## More Information

* deepseek-harness facts were read from the `.repos/deepseek-harness` clone: `registerAdapter` (`packages/llm/llm/src/index.ts:401`), which is removed with the plugin's fiber, and a request bound to the adapter generation that dispatched it (`packages/llm/llm/README.md:129`).
* The session-scope facts were read at commit `b778e2e`: `openSession` returns `Effect<AgentSession, never, Scope>` (`src/host/session/agent-backend.ts`), and `SessionFactory.start` runs it in the pane's scope (`src/host/services/pane-supervisor.ts`).
* Follow-up: an `mcp` plugin that owns MCP server configuration, imported by `org` and `claude-code`.

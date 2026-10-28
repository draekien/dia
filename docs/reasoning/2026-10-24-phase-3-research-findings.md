# Phase 3 research: cordis reloads in three stages, and the SDK skips `canUseTool` for MCP tools in some permission modes

**Date:** 2026-10-24

## Context

Before building Phase 3 of `docs/plans/2026-10-22-plugin-platform.md` (issue #8), two behaviours were looked up: how cordis reloads a changed plugin (for the registry's failure handling), and how the Agent SDK's permission flow treats an in-process MCP tool (for the `dia_plugin_*` tools). Both were read by documentation lookups, not run. The SDK is `@anthropic-ai/claude-agent-sdk` 0.3.207; the docs at code.claude.com/docs/en/agent-sdk are newer than that version in places.

## Reasoning / Learning

### cordis reloads in three stages, and rolls back only the first

Source: `packages/hmr/src/index.ts` in `cordiverse/cordis`, branch `main`, `partialReload`.

| Stage | What happens | On failure |
| --- | --- | --- |
| 1 | Re-import the changed modules, all or nothing | Restore the caches and keep the old plugins running; nothing was stopped |
| 2 | Delete every stale plugin from the registry, together and up front | n/a |
| 3 | Register each replacement again with its old configuration, concurrently | No rollback: the plugin stays failed and is retried on the next change (open issue #243) |

- A stale plugin is one whose dependency tree contains a changed file. The tree is read from Node's internal `ModuleJob.linked`, which needs `--expose-internals`; without it HMR is disabled.
- deepseek-harness (`packages/boot/hmr/README.md`) derives from this package and also leaves a failed replacement inactive. It records inode, size and modification time of package files to detect changes below `node_modules`.
- Neither project documents memory growth from reloads: `gh search issues "memory leak"` on cordis found nothing.

### The SDK does not call `canUseTool` for an MCP tool in some modes

Source: https://code.claude.com/docs/en/agent-sdk/permissions.md and `sdk.d.ts` in 0.3.207.

The documented evaluation order is hooks, deny rules, ask rules, permission mode, allow rules, then `canUseTool`.

| Situation | `canUseTool` for an MCP tool |
| --- | --- |
| `default`, `acceptEdits`, `plan`, no matching allow rule | Called |
| `bypassPermissions` | Not called; the mode approves it |
| An allow rule matches (`allowedTools`, or `permissions.allow` from a settings source) | Not called |
| `dontAsk` | Not called; the call is denied |
| `auto` | Unverified |

- **Forcing a prompt.** An `ask` rule from settings forces the callback even under `bypassPermissions`. A tool whose `_meta["anthropic/requiresUserInteraction"]` is set also forces it, even when an allow rule matches (needs Claude Code 2.1.199 or later). `tool()` does not accept `_meta`, so the `SdkMcpToolDefinition` has to be built by hand, and whether the SDK forwards `_meta` is unverified. A `PreToolUse` hook is documented as the way to gate every call regardless of mode and rules; whether its `ask` decision overrides `bypassPermissions` is unverified.
- **Server instance.** The server returned by `createSdkMcpServer` holds one transport. A second concurrent `query()` reusing it fails with "Already connected" (read from the minified SDK, not documented), so create one per `query()`.
- **Tool names** are `mcp__<server>__<tool>`, so `dia_plugin_override` cannot be the exact name the model sees.
- **`suggestions`.** Returning them as `updatedPermissions` saves an always-allow rule, which would end per-call approval for these tools.
- **Unverified:** an abort signal reaching a tool handler; whether the in-process server closes with the query (the transports do).

## Implication

- The registry validates the new version before closing the running one (plan item 3). A setup failure after the old scope closed reopens the previous setup, which cordis does not do.
- The `plugin_*` tools (`src/host/session/dia-tools.ts`) must not rely on `canUseTool` alone, because the SDK's `bypassPermissions` mode does not call it. dia offers that mode as "Full access"; the approval runs inside each tool's handler (`plugins/claude-code/tool-server.ts`), so it does not depend on the permission mode.
- Create the MCP server inside each `query()` call, not once per pane.

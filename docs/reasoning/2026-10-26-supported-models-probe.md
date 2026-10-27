# Reading `supportedModels()` without starting a turn

**Date:** 2026-10-26

## Context

The model list for the New agent form comes from the Agent SDK's `Query.supportedModels()`. It is a method on a running query, so reading it needs a query, and a query normally starts a turn, writes a transcript and starts MCP servers.

## Reasoning / Learning

Measured with Agent SDK as installed on 2026-10-26 on Windows:

* `query({ prompt, options: { cwd, persistSession: false, strictMcpConfig: true } })` with a `prompt` async iterable that never yields starts the Claude Code process without starting a turn. `supportedModels()` resolved in about 3 s.
* `persistSession: false` wrote no transcript under `~/.claude/projects`. `strictMcpConfig: true` with no `mcpServers` started no MCP server.
* `close()` ended the `claude.exe` process; no new process was left running.
* The reply was 6 rows: `default` ("Default (recommended)"), `opus[1m]`, `claude-fable-5[1m]`, `sonnet`, `haiku`, `claude-sonnet-5-5`. Each row's `value` is what `options.model` accepts, so dia saves `value` and shows `displayName`. The first row is the SDK's default.
* The probe's `cwd` is the plugin's `dataDir`, so a project's `.claude/settings.json` does not affect the list. Not checked: whether user `SessionStart` hooks run for the probe.

## Implication

`plugins/claude-code/model-catalog.ts` (`probeModels`) uses exactly these options and closes the query in a release step, so a timeout or failure never leaves a process behind. Re-check these findings after an Agent SDK upgrade that changes `query()` start-up.

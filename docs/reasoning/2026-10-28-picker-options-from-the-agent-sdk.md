# Thinking levels per model and permission modes the settings turn off

**Date:** 2026-10-28

## Context

The thinking-level and permission-mode pickers offered fixed lists. The thinking picker now offers each model's own levels, and the permission picker adds `bypassPermissions` ("Full access") and leaves out the modes the user's Claude Code settings turn off. t3code, used for comparison, reads its levels from a hand-edited JSON manifest and does not hide disabled modes; it lowers them when a session starts.

## Reasoning / Learning

* **Per-model levels come from `supportedModels()`.** Each `ModelInfo` row has `supportsAdaptiveThinking`, `supportsEffort` and `supportedEffortLevels`. Read with Agent SDK 0.3.311 on 2026-10-28, most rows offered `low` to `max`; `claude-opus-4-6` and `claude-sonnet-4-6` had no `xhigh`; `claude-haiku-4-5-20251001` had none of the three fields. dia maps the row to `ModelOption.adaptiveThinking` and `ModelOption.effortLevels`, and treats a missing field as "not supported".
* **An unsupported effort is not an error.** Claude Code lowers it to the highest supported level at or below it (`xhigh` runs as `high` on Opus 4.6; code.claude.com/docs/en/model-config). Filtering the picker is therefore a display choice, and the session does not need to check the level. `fitThinkingLevel` (`src/renderer/src/lib/thinking-levels.ts`) applies the same rule in the pickers.
* **The SDK reads disabled modes without starting the CLI.** `resolveSettings({ cwd })` (marked `@alpha`) returns the merged managed, user, project and local settings. The SDK `Settings` type has `disableAutoMode` at the top level, while the permissions docs write `permissions.disableAutoMode`; `plugins/claude-code/permission-settings.ts` checks both, and `permissions.disableBypassPermissionsMode`. No `Query` method reports available modes.
* **`allowDangerouslySkipPermissions` must be set when the query starts.** A session started without it cannot switch into `bypassPermissions` later (code.claude.com/docs/en/agent-sdk/permissions). `session.ts` sets it on every query, so the live picker can switch into Full access without a restart.
* **Unverified:** what Claude Code does when a session asks for `bypassPermissions` and the settings disable it. The docs say a disabled `auto` starts the session in `default`.

## Implication

The pickers hide a disabled mode, and the New agent form replaces a disabled default with `default`. A pane already in a mode the settings later turn off keeps it in its picker. Re-read `supportedModels()` field names after an Agent SDK upgrade; the model cache (`models.json`) is version 2, and a version 1 file is ignored and read again.

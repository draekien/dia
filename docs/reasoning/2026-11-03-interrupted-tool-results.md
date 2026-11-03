# An interrupted or rejected tool call still gets a tool result

**Date:** 2026-11-03

## Context

Catch-up (#155) appends a transcript's `tool_use` and `tool_result` entries as `ToolCallStarted` and `ToolCallCompleted` events. A `tool_use` with no `tool_result` would leave a `tool_call` item running forever, so the design first added a rule to complete such calls during the mapping. To decide whether the rule was needed, 216 transcripts under `~/.claude/projects/` were scanned for `tool_use` blocks with no matching `tool_result`.

## Reasoning / Learning

| Case | `tool_result` written | Count in the scan |
| --- | --- | --- |
| The user pressed Esc during the tool call | `is_error: true`, content `[Request interrupted by user for tool use]` | 3 |
| The user rejected the permission request | `is_error: true`, content starts `The user doesn't want to proceed` | 24 |
| `tool_use` with no `tool_result` | none | only as the last entry of a session that was still running |

The CLI writes a result for every call it ends, including interrupted and rejected ones. A call without a result means the session has not finished that call yet.

## Implication

- Catch-up needs no rule to complete orphaned tool calls; the rule was dropped from the design.
- A `tool_call` item left running by catch-up belongs to a session that was running when dia read its transcript; the next catch-up reads its `tool_result`.

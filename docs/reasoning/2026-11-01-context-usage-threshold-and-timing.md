# `autoCompactThreshold` is a token count; `getContextUsage` answers mid-turn and its `summary` is stale after compaction

**Date:** 2026-11-01

## Context

Issue #84 left two questions open before the adapter could report context usage: is `SDKControlGetContextUsageResponse.autoCompactThreshold` a token count or a percentage (the type has no doc comment), and can `Query.getContextUsage` be called while a turn runs?

## Reasoning / Learning

A probe on SDK 0.3.311 with Claude Code 2.1.314 (`haiku`, `persistSession: false`, no tools) called `getContextUsage({ detail: 'summary' })` three times:

| Read point | `totalTokens` | `maxTokens` | `percentage` | `autoCompactThreshold` | Latency |
| --- | --- | --- | --- | --- | --- |
| Before the first prompt was read | 28004 | 400000 | 7 | 367000 | 1636 ms |
| At the first `stream_event` of the turn | 42444 | 400000 | 11 | 367000 | 5 ms |
| After the `result` message | 37410 | 400000 | 9 | 367000 | 6 ms |

- `autoCompactThreshold` is a token count: 367000 of a 400000 window (91.75%).
- `percentage` is `round(totalTokens / maxTokens × 100)` in every reading, so dia derives it instead of carrying it.
- The call answers mid-turn. The mid-turn reading includes a local estimate of the streaming reply and is higher than the reading after the turn.
- The first call on a new query takes about 1.6 s because it waits for the CLI to start. Later calls take a few milliseconds.

A second probe ran a turn, then `/compact`, then one more turn, reading both `detail` values each time:

| Read point | `summary` | `full` |
| --- | --- | --- |
| After turn 1 | 37796 | 37796 |
| At `compact_boundary` (`pre_tokens` 41342, `post_tokens` 11832) | 42237 | 37075 |
| After the `/compact` turn's `result` | 42237 | 37075 |
| After the next turn | 37727 | 37727 |

- `summary` answers from the last API response, and the compaction call is not one, so it reports the pre-compaction estimate until the next real turn.
- `full` is right straight after compaction. 37075 is the compacted messages plus about 25k of system prompt and tools; `post_tokens` counts messages only.
- In the app the same happened: both `summary` readings after `/compact` read 39569 against `post_tokens` 12046.

## Implication

`ContextUsage.autoCompactThreshold` (`src/shared/domain/context-usage.ts`) is in tokens. Compare it with `totalTokens`, not with a percentage. A read is safe at any point in a turn. Read with `full` after a compaction, never `summary`. The adapter reads `full` at the end of a turn that compacted and after a reset, and `summary` everywhere else (`docs/designs/context-usage.md`).

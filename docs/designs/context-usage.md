# Context usage reporting

Issue #84. The claude-code adapter reads a tab's context window usage from the Agent SDK and reports it to the renderer, for the composer's context donut (#86).

## Contract

```ts
// src/shared/domain/context-usage.ts
const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ContextUsage = Schema.Struct({
  totalTokens: TokenCount,                        // tokens in the window now
  maxTokens: TokenCount,                          // window size
  autoCompactThreshold: Schema.optional(TokenCount) // tokens; present only while auto-compact is on
})
```

| Layer | Name | Carries |
| --- | --- | --- |
| Session protocol (`src/host/session/protocol.ts`) | `ContextUsageChanged` | `usage: ContextUsage` |
| Renderer event (`src/shared/ipc/contract.ts`) | `PaneContextUsageChanged` | `paneId`, `usage` |
| Preload (`DiaApi`) | `onContextUsageChanged(listener)` | the event |
| Renderer state (`PaneChatState`) | `contextUsage: ContextUsage \| null` | the latest reading; `null` before the first |

`PaneContextUsageChanged` is a pane event, so it is replayed to a reconnecting client like every other pane event. `PROTOCOL_VERSION` goes from `0.0.10` to `0.0.11`.

## Adapter

`plugins/claude-code/context-usage.ts` owns the one call to `Query.getContextUsage`:

```ts
readContextUsage(query, detail: 'summary' | 'full'): Effect<SDKControlGetContextUsageResponse, ContextUsageReadError>
toContextUsage(response): ContextUsage
```

#79 (`/context` view) calls `readContextUsage(query, 'full')`; this issue calls it with `'summary'`.

`runSession` in `session.ts` reads and emits `ContextUsageChanged`:

| When | Why |
| --- | --- |
| the query opens (next to the slash command warm-up) | a started or resumed session shows its usage before the first turn |
| after a turn ends (`TurnCompleted`, `TurnErrored`, `TurnParked`) | each `SDKResultMessage` changes usage |
| after `ConversationCompacted` | compaction shrinks the window |
| after `ConversationReset` | `/clear` empties the window |

A read runs in a fiber forked into the query's scope, so it never delays the event stream and ends when the query closes. A failed read logs a warning and emits nothing: the renderer keeps the last value.

## Decisions

| Decision | Reason |
| --- | --- |
| `autoCompactThreshold` is a token count | Probe on SDK 0.3.311 / Claude Code 2.1.314: `maxTokens` 400000, `autoCompactThreshold` 367000. See `docs/reasoning/2026-11-01-context-usage-threshold-and-timing.md`. |
| `isAutoCompactEnabled` is folded into whether `autoCompactThreshold` is present | A disabled auto-compact with a threshold cannot be represented, so the renderer has one rule: no threshold means the 90% default (#86). |
| `percentage` is not carried | It equals `round(totalTokens / maxTokens × 100)` in every probe reading. Carrying both allows them to disagree. |
| No read on `SessionStarted` | The query-open read already covers a start or resume, and arrives before the first turn. |
| Reads are allowed mid-turn | The probe read in 5 ms during streaming. No current read point needs it, but a future one is safe. |

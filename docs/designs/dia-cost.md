# `dia-cost` plugin

Issue: draekien/dia#251, step 13 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0076. Builds on `dia-run-events` (`docs/designs/dia-run-events.md`) and `dia-runs` (run id = pane id).

`dia-cost` shows, on a `Usage` card of the chat session rail, the tokens each turn of a run used (input, output, cache read, cache write) and the run's total. The adapter reports each turn's usage as a run event; `dia-cost` reads those events from the run's log and follows new ones. The name `dia-cost` is the issue's provisional name and is kept.

## Success criteria

1. Each turn's usage is recorded as a run event. (Test: `plugins/dia-claude-code/reducer.test.ts`: a `result` message whose `usage` has non-zero tokens yields `TurnUsageReported` with those four counts after the flushed tool calls and before `TurnCompleted`; a parked, a refused and an error result do the same before `TurnParked` or `TurnErrored`; a result whose four counts are all 0 yields no `TurnUsageReported`. The tests feed fixture `SDKMessage`s and start no Claude process. `plugins/dia-runs/run-registry.test.ts`: `TurnUsageReported` is stored as `PaneTurnUsageReported` of the run.)
2. A run's stored usage events can be read without reading the whole log. (Test: `plugins/dia-run-events/store.test.ts`: `readTagged(runId, ['PaneTurnUsageReported'])` returns only that run's events with that tag, in sequence order, and skips an undecodable row with a warning. `2_index_run_events_by_type` applies over a database at migration 1.)
3. Each run shows input, output and cache tokens per turn and in total. (Test: `plugins/dia-cost/usage.test.ts`: folding `PaneUserMessagesSent('fix the bug')`, `PaneTurnUsageReported(a)`, `PaneUserMessagesSent('next')`, `PaneTurnUsageReported(b)` gives two turns keyed by the ids of those messages, usages `a` and `b`, and total `a + b`; a second report adds to the latest turn; a turn with no report keeps 0 tokens. `plugins/dia-cost/host.test.ts`: `FollowRunUsage({ runId })` emits the stored turns first, then new values after events of that run are committed, ignores other runs and an event already read. `usageOfMessages` sums the turns any given message started. `plugins/dia-chat/turn-ends.test.ts`: each turn ends at the last message before the next user message. `plugins/dia-cost/turn-usage-line.test.tsx`: the line shows `~95k tokens` for 94,860 tokens, the four counts on focus, and nothing for 0. App: send two turns in a tab; each turn ends with its token line, the `Usage` card shows a total equal to their sum, and both show the same after a restart.)

## Decisions taken without the user

D1. **No dollar amount; tokens only.** The SDK's per-turn `usage` carries no price. `total_cost_usd` and `modelUsage[*].costUSD` are cumulative per `query()` call, a resumed session's first result already includes the earlier turns, and `/clear` resets them (`sdk.d.ts`, `SDKResultSuccess.total_cost_usd` and `modelUsage` JSDoc), so a per-turn figure needs differencing that a resume breaks. A price table in dia would go stale and duplicate Claude Code's own `modelPricing` setting, and a subscription account is not billed per token (paperclip records such usage with `billingType: 'subscription_included'` and `costStatus: 'unpriced'`, `.repos/paperclip/packages/db/src/schema/cost_events.ts`). Alternatives: a price table per model (rejected: stale data, wrong for subscriptions); the latest `total_cost_usd` as a session estimate (deferred: no step asks for it, and it is per process, not per run).

D2. **A turn's tokens are the result message's `usage` (main agent loop).** Its JSDoc reads "MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls, and is per-turn in streaming-input sessions. Prefer modelUsage for token/cost accounting." It is per turn in streaming-input sessions, which dia's adapter uses (`plugins/dia-claude-code/session.ts`, `query({ prompt: input.prompts })`). The counts therefore leave out subagent and compaction tokens; the card says "Main agent tokens". Alternative: difference the cumulative `modelUsage` between consecutive results (rejected: a resumed process's first result includes earlier turns, which would be counted twice; see D1). t3code also reads per-turn usage from the Claude messages (`.repos/t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `claudeProviderTurnTokenUsage`).

D3. **Usage travels as a new pane signal, `PaneTurnUsageReported`, stored in the run's log.** Every `PaneSignal` is stored by `dia-runs` (`run-registry.ts`, `appendSignal`) and replayed, so "read from run events" needs no new write path. Adding it to `IpcEvent` changes `GlobalEventFrame` in `src/shared/ipc/rpc.ts`, so `PROTOCOL_VERSION` (0.0.30) is bumped; `FollowRunUsage` is a plugin call and needs no bump. The chat reducer and agent summaries ignore it (`isPaneStreamEvent`, `foldSummary` default).

D4. **`RunEvents` gains `readTagged(runId, tags)`**, a read of one run's events whose tag is in `tags`, backed by a new index `run_events_by_type (run_id, event_type, sequence)`. Alternatives: `readAfter(runId, 0, limits)` (rejected: it loads every event of the run, including each streaming text update, and fails `tooLarge` on a long run); a table of usage in `dia-cost`'s own database filled by following `subscribe` (rejected: it misses events committed while `dia-cost` is not loaded, and duplicates what the log holds).

D5. **A turn starts at each `PaneUserMessagesSent`, named by the first line (at most 120 characters) of `messages[0].text`; each `PaneTurnUsageReported` adds its tokens to the latest turn.** This is the turn rule of `dia-checkpoints` (`boundaries.ts`, `TurnStart`), so the Usage and Changes cards give a turn the same number. A parked turn resumed with `continue` sends no message, so its second report adds to the same turn. A turn that reported no usage (it used no tokens, it is still running, or it ran before this change) keeps 0 tokens and its number; the card lists only turns with tokens. Usage reported before any message forms an unnamed turn 1 (`Turn 1` with no prompt). Turns that a rewind or `/clear` discarded stay listed: their tokens were spent. Turns added outside dia (transcript catch-up) have no events and are not counted. The prompt rule duplicates `promptOf` in `plugins/dia-checkpoints/boundaries.ts` (6 lines) rather than exporting that plugin's module (rejected: an `exports` entry and two tsconfig includes for one function, and a dependency of `dia-cost` on `dia-checkpoints`). Earlier draft: one turn per usage event, named by the first message since the previous one (replaced after the simplify pass: a turn with no report shifted every later number away from the Changes card).

D6. **A result whose four counts are all 0 reports nothing.** Crash and startup-error results may carry zeroed usage (`sdk.d.ts`); a turn of zeros is noise.

## Interface

### Kernel

`src/shared/domain/context-usage.ts` (beside `ContextUsage`, sharing its `TokenCount`):

```ts
/** Tokens one turn or run used: prompt input, output, input read from the prompt cache, and input written to it. Each is a non-negative integer. */
export const TokenUsage = Schema.Struct({
  inputTokens: NonNegativeInt, outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt, cacheWriteTokens: NonNegativeInt
})
export type TokenUsage = typeof TokenUsage.Type
```

Exported from `@dia/plugin`.

`src/host/session/protocol.ts`: `TurnUsageReported = Schema.TaggedStruct('TurnUsageReported', { usage: TokenUsage })`, joining `OutboundMessage`, emitted before the turn's end message.

`src/shared/ipc/contract.ts`: `PaneTurnUsageReported = Schema.TaggedStruct('PaneTurnUsageReported', { paneId: Uuid, usage: TokenUsage })`, joining `PaneSignal`. `PROTOCOL_VERSION` bumped.

`src/host/services/run-events-seam.ts`, `RunEvents` gains:

```ts
/**
 * The events of run `runId` whose tag is one of `tags`, in sequence order. An event that does not
 * decode is left out and logged. Fails with RunEventReadError when the log cannot be read.
 */
readonly readTagged: (runId: string, tags: NonEmptyReadonlyArray<StoredEvent['_tag']>) =>
  Effect<ReadonlyArray<CommittedEvent>, RunEventReadError>
```

`functionMembers` in `isRunEvents` gains `'readTagged'`; `RunEventLog` omits it (no kernel caller). Every hand-built `RunEvents` gains it: `src/host/services/event-hub-test-layer.ts`, `src/host/services/run-event-log.test.ts`, `plugins/dia-run-events/host.ts`, `plugins/dia-run-events/recorder.test.ts`, `plugins/dia-checkpoints/host.test.ts`, `plugins/dia-run-messaging/messaging.test.ts`.

### Adapter and runs

- `plugins/dia-claude-code/reducer.ts`: on a `result` message, emits `TurnUsageReported` once from `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (D6), after `flushed` and before whichever of `TurnParked`, `TurnErrored` (refusal), `TurnCompleted` or `TurnErrored` (error result) the branch returns.
- `plugins/dia-runs/live-run.ts` `toIpcEvent`: a `Match.tag('TurnUsageReported', …)` case mapping to `PaneTurnUsageReported` before `Match.exhaustive`; the other `OutboundMessage` matches (`statusAfter`, `toAttentionTarget`, the recorder) have defaults.

### `dia-run-events`

- `store.ts`: `readTagged` as `SELECT sequence, payload_json FROM run_events WHERE run_id = ${runId} AND ${sql.in('event_type', tags)} ORDER BY sequence`, following `readHistory`: `asRead` maps a failure to `RunEventReadError` and logs it, and each undecodable row is logged and left out. With more than one tag SQLite sorts the matched rows; a run has one usage event per turn.
- `migrations.ts`: `2_index_run_events_by_type` creates `run_events_by_type`.
- `host.ts`: provides it.

### Plugin (`plugins/dia-cost`)

`plugin.json`: `name: dia-cost`, `api: 0.0.42`, `category: feature`, `host: host.ts`, `renderer: renderer.ts`, `load: eager`; no exports. `tsconfig.web.json` includes `plugins/dia-cost/calls.ts` and `plugins/dia-cost/usage.ts`. Every new export carries JSDoc.

`calls.ts`:

```ts
/** One turn of a run: the ids of the messages that started it, and its tokens. */
export const TurnUsage = Schema.Struct({ messageIds: Schema.Array(Schema.String), usage: TokenUsage })
/** A run's turns in order and their total. */
export const RunUsage = Schema.Struct({ turns: Schema.Array(TurnUsage), total: TokenUsage })
/** Run `runId`'s usage now and after each usage event of the run; no turns while run events are not provided. */
export const FollowRunUsage = Rpc.make('FollowRunUsage', { payload: { runId: Schema.String }, success: RunUsage, stream: true })
```

Internal modules:

- `usage.ts` — owns the turn rule (D5): `emptyRunUsage`, `foldUsage(usage: RunUsage, event: StoredEvent): RunUsage` (other tags return `usage` unchanged), and `USAGE_TAGS` (`PaneUserMessagesSent`, `PaneTurnUsageReported`).
- `host.ts` — `ctx.whenProvided([RunEventsKey])` holds `RunEvents` in a `SubscriptionRef`; `FollowRunUsage` switches on it: none → one empty `RunUsage`; some → `subscribe`, then `readTagged(runId, USAGE_TAGS)`, fold, emit, then fold and emit each subscribed event of `runId` with a tag in `USAGE_TAGS` whose sequence is above the highest sequence `readTagged` returned (0 when it returned none). `logDebug` on follow start with the run id and turn count. A failed read logs a warning and emits the empty usage, as `dia-checkpoints`' `turnsOf` does for a `GitError`.
- `usage-card.tsx`, `renderer.ts` — `RailCardsSlot` entry `Usage` (order 50) for the visible pane: one line with the run's total, `620,773 tokens · main agent`.
- `turn-usage-line.tsx`, `renderer.ts` — `TurnFootersSlot` entry `turn-usage` (order 10): under each turn of the transcript, the tokens of the turns its user messages started (`usageOfMessages`), rounded with `approximateTokens` from `@dia-plugin/dia-chat/token-count`, and the four counts in a tooltip. Nothing for a turn with no tokens.

## Redesign: per-turn usage in the transcript

The per-turn list moved from the rail card to the transcript; the card keeps only the total (DESIGN.md, Turn steps › Turn footers and Session rail).

D7. **`dia-chat` declares `TurnFootersSlot`**, a list of components drawn after a turn's last message with `{ paneId, messageIds }`. `turnEnds` (`plugins/dia-chat/turn-ends.ts`) ends a turn at the last message before the next user message; `messageIds` are the consecutive user messages that open it. A footer that throws renders nothing (DESIGN.md, Plugin failure: a status line shows nothing). Alternative: a turn number in the props (rejected: the transcript cannot number turns by the D5 rule, because turns added outside dia and batched sends would shift the numbers).
D8. **`TurnUsage` carries `messageIds`**, the ids of the messages of its `PaneUserMessagesSent`, which are the ids of the transcript's user messages. A transcript stretch shows the sum of the turns any of its user messages started. A parked turn resumed with `continue` is two turns by D5, so it shows two lines: one before the `Resumed at` marker and one at the end. `FollowRunUsage` is a plugin call, so `PROTOCOL_VERSION` is unchanged.
D9. **`token-count.ts` is exported from `dia-chat`**, so the turn line rounds as the compaction notice does (`~95k`).
D10. **`TurnUsage` drops `turn` and `prompt`.** Only the removed per-turn list of the card read them; the transcript shows each turn's prompt above its line. The D5 prompt rule and its copy of `promptOf` are removed with them.


## Refinement Record

**Round 1 (subagent, sonnet) — applied**
- *Correctness, major* — the reducer has four end branches, not three; named each and the tests cover all four.
- *Correctness, major* — every hand-built `RunEvents` and `functionMembers` gain `readTagged`.
- *Correctness, major* — `tsconfig.web.json` include for the renderer's imports.
- *Minor* — follow cutoff when the read returns nothing; `messages[0].text`; queued sends and rewound turns in D5; exhaustive `toIpcEvent` case; D2 quotes the `usage` JSDoc and the card says "Main agent tokens"; `sql.in`, the sort note and the migration test; JSDoc on all exports; follow-start log; Claude-free tests; D3 names `GlobalEventFrame`.

**Round 1 — rejected**
- *Major, a failed read should end the stream with `UsageUnavailable`* — rejected: the read fails only when the plugin database cannot be read, which breaks the chat too; the `dia-checkpoints` precedent emits empty and logs, and a typed error adds a call error and a card state for that case alone.
- *Minor, rename the plugin `dia-usage`* — rejected: the plan row and the issue name the step "Cost"; the name keeps the place for a later dollar estimate (D1).
- *Minor, drop `RunUsage.total`* — rejected: `foldRunUsage` is its single owner, and the card would otherwise repeat the sum.

**Round 2 (inline) — applied**
- *Minor, Correctness* — `foldRunUsage(usage, event): RunUsage` could not carry the pending prompt; the fold state is now `UsageFold`.

No blocker or major finding in round 2; rounds stopped.

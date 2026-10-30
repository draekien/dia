# Parked agents

Status: accepted (after round 3). Issue #23 part 2. Branch `feat/parked-agents`.

## Name and Purpose

**Parking** keeps an agent whose turn the account refused (usage limit reached, or Claude Code signed out) waiting instead of failed, and sends it `continue` when the limit resets or when the user resumes it.

Scope: layer. It spans the Claude Code adapter (`plugins/claude-code`), the session protocol (`src/host/session`), the pane supervisor (`src/host/services`), the shared domain (`src/shared/domain`), the IPC contract and the renderer.

Out of scope: OS notifications (dia has no notification code; checked by searching `src/` and `plugins/`), a refusal as needs input (#23 part 3), #63, #64, and a parked state that survives an app restart (#69).

## Interface

### Shared domain: `src/shared/domain/parking.ts` (new)

```ts
/** The account's usage limit refused the turn. `resetsAt` is epoch milliseconds, or null when the SDK sent none. */
UsageLimit = Schema.TaggedStruct('UsageLimit', { resetsAt: Schema.NullOr(Schema.Int) })
/** Claude Code is not signed in, so the account refused the turn. */
SignedOut  = Schema.TaggedStruct('SignedOut', {})
/** Why the account refused a turn. Branch on `_tag`; pass it to `resumesAtFor`. */
ParkCause  = Schema.Union([UsageLimit, SignedOut])

/** What dia does when a usage limit resets: send `continue` itself, or wait for the user. */
UsageLimitResume = Schema.Literals(['automatic', 'manual'])
/** The resume mode when the user has not chosen one. */
DEFAULT_USAGE_LIMIT_RESUME: UsageLimitResume = 'automatic'
/** The longest wait dia schedules; a later reset waits for the user. */
MAX_AUTOMATIC_WAIT = Duration.days(7)
/** How long after the reset dia sends `continue`, so a timer that fires early does not meet the limit again. */
RESUME_GRACE = Duration.seconds(5)

/**
 * When dia will send `continue` by itself, or null to wait for the user: `resetsAt + RESUME_GRACE`
 * under `automatic` when `resetsAt` lies after `nowMs` and the result is no more than
 * `MAX_AUTOMATIC_WAIT` ahead, else null.
 */
resumesAtFor(cause: ParkCause, mode: UsageLimitResume, nowMs: number): number | null
```

### Attention: `src/shared/domain/attention.ts`

```ts
/** A pane whose turn the usage limit refused; dia sends `continue` at `resumesAt` (epoch ms). */
ParkedToResume = Schema.TaggedStruct('ParkedToResume', { cause: UsageLimit, resumesAt: Schema.Int })
/** A pane whose turn the account refused; it waits for the user to resume it. */
ParkedForUser  = Schema.TaggedStruct('ParkedForUser', { cause: ParkCause })
AttentionState = Schema.Union([Idle, AwaitingPermission, Errored, Crashed, Completed, ParkedToResume, ParkedForUser])
```

New transitions, for each of `ParkedToResume` and `ParkedForUser` (written `Parked*`): `Idle->Parked*`, `AwaitingPermission->Parked*`, `Completed->Parked*`, `Parked*->Idle`, `Parked*->Crashed`; plus `ParkedToResume<->ParkedForUser` and each to itself (the resume mode changed). A send while parked reaches `Idle` through `UserMessagesSent`. `Errored->Parked*` is not added: every turn begins with `UserMessagesSent`, which applies `Idle`.

### Session protocol: `src/host/session/protocol.ts`

```ts
/** The account refused the turn; the agent waits instead of failing. Ends the turn. */
TurnParked = Schema.TaggedStruct('TurnParked', { cause: ParkCause })
```

`OutboundMessage` gains `TurnParked`; `toIpcEvent` maps it to `Option.none()`. `TurnParked`, `UsageLimit`, `SignedOut` and `ParkCause` are exported from `src/host/plugin-api.ts` (`@dia/plugin`); the adapter builds causes only from those exports, because a shipped plugin cannot import `src/`.

### Agent session: `src/host/session/agent-backend.ts`

```ts
interface AgentSession {
  /**
   * Sends `continue` to a session whose last turn was parked, ahead of any held queue; the held
   * messages run after it, in order. Does nothing while a turn is running.
   */
  readonly resume: Effect.Effect<void>
}
```

`unavailableSession` (agent-backend.ts) and the adapter's `unstartedSession` (session.ts) implement it as a no-op. `PLUGIN_API_VERSION` goes from `0.0.4` to `0.0.5`, because the adapter's `AgentSession` gains a required member (`src/shared/plugin/manifest.ts`: increment the patch version on every change to the plugin context). The six `plugins/*/plugin.json` files that declare `"api": "0.0.4"` and any test fixture pinning the version move to `0.0.5`.

### Pane supervisor: `src/host/services/pane-supervisor.ts`

```ts
interface PaneHandle {
  /** Resumes a parked pane (see AgentSession.resume). Does nothing unless the pane is parked. */
  readonly resume: Effect.Effect<void>
}
PaneSupervisor {
  /** Stores the resume mode in settings and re-parks every parked pane under it. */
  readonly setUsageLimitResume: (mode: UsageLimitResume) => Effect.Effect<void>
}
```

`PaneSupervisorLive` requires `SettingsStore`; `host-main.ts` provides it: `Layer.provide(PaneSupervisorLive, Layer.mergeAll(sessionFactory, hostPlugins, settings))`. `settings` is a standalone layer built before `supervisor` (host-main.ts:77, :95), so this adds no cycle; the supervisor's test layers provide a `SettingsStore` too. `SettingsStore` gains `getUsageLimitResume: Effect<Option<UsageLimitResume>>` and `setUsageLimitResume`; `Settings` gains `usageLimitResume: Schema.optional(UsageLimitResume)`. `startPane` returns a `repark(mode)` with the handle; `PaneEntry` stores it. `repark` reads the pane's attention from its record and, when it is `Parked*`, applies the `Parked*` state `resumesAtFor` gives under `mode`, and logs. It is not on `PaneHandle`. Every `AgentSession` fake (pane-supervisor tests and others) and every `PaneHandle` fake (rpc and workspace tests) gains `resume`.

### Agent status: `src/shared/domain/agent-summary.ts`

```ts
/** The agent waits for the usage limit to reset; dia sends `continue` at `resumesAt` (epoch ms). */
StatusParked = Schema.TaggedStruct('StatusParked', { resumesAt: Schema.Int })
AgentStatus  = Schema.Union([StatusNeedsInput, StatusFailed, StatusParked, StatusWorking, StatusFinished, StatusIdle])
AgentSummary gains  parked: Schema.optional(ParkCause)     // present while the pane is parked
```

`foldSummary` on `PaneAttentionChanged`:

| Attention | `status` | `parked` |
|---|---|---|
| `ParkedToResume { cause, resumesAt }` | `StatusParked { resumesAt }` | `cause` |
| `ParkedForUser { cause: UsageLimit }` | `StatusNeedsInput { reason: 'Usage limit reached' }` | `cause` |
| `ParkedForUser { cause: SignedOut }` | `StatusNeedsInput { reason: 'Claude Code is signed out' }` | `cause` |
| `Idle` when `status` is `StatusParked`, or `StatusNeedsInput` with `parked` set (checked before the existing `Idle` rule) | `StatusIdle` | removed |
| `Idle` otherwise | as today | removed |
| any other | as today | removed |

`PaneUserMessagesSent` also removes `parked`. The supervisor offers the IPC event before it applies attention, so a resume folds `PaneUserMessagesSent` (working, `parked` removed) before `Idle`, and the parked `Idle` row does not apply to it.

`statusRank`: needs input 0, failed 1, parked 2, working 3, finished 4, idle 5. Its JSDoc lists these ranks.

### IPC: `src/shared/ipc/rpc.ts`, `contract.ts`, preload, `dia.d.ts`

```ts
Rpc.make('GetUsageLimitResume', { success: UsageLimitResume })
Rpc.make('SetUsageLimitResume', { payload: { mode: UsageLimitResume } })
/** Command: resume the parked agent in pane `paneId`. */
ResumeParkedAgent = Schema.TaggedStruct('ResumeParkedAgent', { paneId: Uuid })
Rpc.make('ResumeParkedAgent', { payload: withRequestId(ResumeParkedAgent) })
DiaApi.getUsageLimitResume(): Promise<UsageLimitResume>
DiaApi.setUsageLimitResume(mode): Promise<void>
DiaApi.resumeParkedAgent(paneId): void
PROTOCOL_VERSION = '0.0.7'
```

`SetUsageLimitResume` calls only `PaneSupervisor.setUsageLimitResume`. `ResumeParkedAgent` is deduped by `commandId` and calls `PaneHandle.resume` on the pane's live handle; a pane with no live handle is skipped with a log line. The `DiaRpcs` doc comment names the get and set as safe to repeat.

### Renderer

- `src/renderer/src/lib/account-banner.ts` (new):
  - `awaitsUser(summary: AgentSummary, nowMs: number): boolean`: the agent is parked for the user and its reset time has passed or is unknown, or it is signed out. Used by the banner and by the transcript's Resume button.
  - `accountBannerOf(summaries: ReadonlyArray<AgentSummary>, nowMs: number): AccountBanner | null`, a pure function. The variants are named `Schema.TaggedStruct` exports built with `.make`, and `AccountBanner` is their `Schema.Union`; each has a JSDoc line. Checked in this order:
    - `SignedOutBanner { paneIds }`;
    - `LimitResetBanner { paneIds }`: some usage-limit agent with a known `resetsAt` `awaitsUser`;
    - `LimitUnknownBanner { paneIds }`: some usage-limit agent with `resetsAt: null` `awaitsUser`;
    - `LimitWaitingBanner { resetsAt: Schema.Int }`: some usage-limit agent is parked for the user and its reset has not passed; the earliest reset;
    - `LimitResumingBanner { resumesAt }`: every parked agent is `StatusParked`; the earliest `resumesAt`.
- `src/renderer/src/hooks/use-now.ts` (new): `useNow(interval: Duration)` returns the current epoch ms, refreshed every `interval`. The banner and the transcript's Resume button use `useNow(Duration.minutes(1))`, so a passed reset shows Resume.
- `src/renderer/src/components/account-banner.tsx` (new): reads `useAgentSummaries()`, renders the banner, is exported from `src/renderer/src/plugin-api.ts` (`@dia/renderer-plugin`) and rendered by `plugins/layout/layout.tsx` between the `<Separator />` and `<Slot name={MAIN} />`. Copy:
  - `Claude Code is signed out. Run claude in a terminal and sign in, then` [Retry]
  - `Usage limit reset ·` [Resume all]
  - `Usage limit reached ·` [Resume all]
  - `Usage limit reached · resets 14:30`
  - `Usage limit reached · resumes 14:30`
  Retry and Resume all call `window.dia.resumeParkedAgent` for each pane in `paneIds`. Neutral surface, never amber or red. `format-when.ts` exports `formatResetTime(epochMs, nowMs): string` (`14:30` on the same local day, else `Fri 14:30`); the banner, the transcript notice and the overview row all use it.
- `pane-chat.ts`: `PaneAttentionChanged` with `ParkedToResume` or `ParkedForUser` sets `isLoading: false` (`isTurnOver` includes both), leaves the queue fields as `MessageQueueChanged` reports them, and adds a `notice` row with the text `Usage limit reached · resumes 14:30`, `Usage limit reached · resets 14:30`, `Usage limit reached` or `Claude Code is signed out`. A park notice has the id `${n}:parked`; the next park replaces the last row when its id ends in `:parked`, so a mode change does not repeat it. A resume sends a real `continue` user message, so `appendSentMessages` shows it as a user row and it becomes `lastUserText`; this is intended, because the transcript read back from disk after a restart holds the same message.
- `plugins/chat`: while the pane is parked and its summary (from `useAgentSummaries()`, with `nowMs` from `useNow`) `awaitsUser`, a `Resume` button under that notice calls `window.dia.resumeParkedAgent(paneId)`.
- `status-indicator.tsx`: `statusDot` gains `StatusParked: 'bg-ink-muted/40'` (filled and dimmed: distinct from Working's full-strength dot even with `still`, and from Idle's hollow ring); no ring; `STATUS_LABELS` gains `StatusParked: 'Parked'`; the component JSDoc lists the parked dot. `plugins/agent-overview/overview.ts` `StatusTag` gains `StatusParked` at rank 2, and the filter sample and counts follow. `plugins/agent-overview/agent-row.tsx` gains a `StatusParked` case whose second line is `Resumes 14:30`; a `StatusNeedsInput` row with `parked` set shows its `reason` as today.
- `general-settings.tsx`: a `When the usage limit resets` row with a `Resume automatically | Wait for me` toggle group, backed by an atom in the `send-mode-atom.ts` pattern.

## Key Data Structures

- `ParkCause`: `UsageLimit { resetsAt: epoch ms | null }` or `SignedOut {}`, in epoch milliseconds, converted from the SDK's seconds in the reducer so later readers use one unit.
- `ParkedToResume { cause: UsageLimit, resumesAt }` and `ParkedForUser { cause }`: two tags, so a signed-out pane with a resume time cannot be built.
- `StatusParked { resumesAt }`: exists only for `ParkedToResume`.

## Internal Decomposition

- **Refusal detection** (`plugins/claude-code/reducer.ts`): owns what the SDK says about the account. During a turn it records a cause:
  - a `rate_limit_event` whose `rate_limit_info.status` is `'rejected'` and whose `overageStatus` is not `allowed` or `allowed_warning` gives `UsageLimit { resetsAt: Math.round(resetsAt * 1000) }` (null when `resetsAt` is absent);
  - an assistant message with `error: 'rate_limit'` gives `UsageLimit` with the last rejected event's reset time, or null;
  - `error: 'authentication_failed'` gives `SignedOut`.
  The `result` that ends the turn emits `TurnParked { cause }` in place of `TurnCompleted` or `TurnErrored` (after flushing pending tool calls) when a cause is recorded and the result's subtype is not `success` or its `is_error` is true. A `success` result with `is_error: false` drops the cause. The cause is cleared at every turn end. `ENDS_TURN_STATUS` gains `TurnParked`. The assistant message that carries the error still emits its text as `AssistantMessageReceived`, so the transcript keeps the CLI's wording. The reducer does not log; the supervisor logs each park decision.
- **Queue resume** (`plugins/claude-code/message-queue.ts`): `resume(message)(state)`. From `QueueIdle` it returns `[[...(state.held ? [queueChanged(state.queued, false)] : []), ...actions], next]` where `[actions, next] = dispatchNow([message], state.queued, false)`: it dispatches `[message]` and moves to `QueueRunning { queued: state.queued, held: false, steered: [], dispatching: 1 }`, so the held messages dispatch when that turn ends without failing. From `QueueRunning` it returns `[[], state]`.
- **Turn ends in the session** (`plugins/claude-code/session.ts` `forward`): `isTurnEnd` includes `TurnParked`; step (1) resets `silentResultsRef` for `TurnParked` as for `TurnErrored`; the `abortExpectedRef` branch rewrites `TurnParked` to `TurnCompleted` as it rewrites `TurnErrored`, so a Stop on a refused turn ends it cleanly; `onTurnEnded(outbound._tag === 'TurnCompleted')` is false for `TurnParked` and holds the queue. `resume` builds the `continue` message and applies the queue's `resume`.
- **Park lifecycle** (`pane-supervisor.ts`): owns each pane's attention.
  - `toAttentionTarget` returns none for `TurnParked`. `handleSessionEvent` handles `TurnParked` before the generic attention step: it reads the mode from `SettingsStore` and `Clock.currentTimeMillis`, and applies `ParkedToResume` when `resumesAtFor` returns a time, else `ParkedForUser`. A `continue` refused again parks again; `resumesAtFor` returns null for a reset that is not after `nowMs`, so a repeat refusal for a past reset waits for the user.
  - `settleFiberRef` is renamed `timerFiberRef`. Entering `ParkedToResume` forks a fiber that sleeps `Duration.millis(resumesAt - nowMs)`, clears the slot, then calls `session.resume`; clearing first means the `UserMessagesSent` it causes does not interrupt the fiber (docs/reasoning 2026-07-12).
  - `applyAttention` validates the transition first, then interrupts the fiber in `timerFiberRef`, then forks the new one. A rejected transition keeps the running timer, and `ParkedToResume -> ParkedToResume` restarts it with the new `resumesAt`. Today `applyAttention` interrupts before it validates; the order changes.
  - `PaneHandle.interrupt` applies `Idle` as today, which also leaves a parked state. `PaneHandle.rewindToCheckpoint` applies `Idle` when the pane is parked.
  - `setUsageLimitResume(mode)` stores the mode, then re-parks every parked pane with its cause under the new mode.
  - It logs at Info with `paneId` on each park decision (cause, mode, `resumesAt`), when the timer fires, on a re-park, and when a resume is skipped.
- **Status fold** (`agent-summary.ts`): owns how attention reads in the overview, per the table under Agent status.
- **Account banner** (`account-banner.ts`, `account-banner.tsx`): owns the app-wide view of parked agents, derived from agent summaries and a minute clock.

## Design Rationale

**Park as a turn ending, not a separate event.** The SDK does not document which message ends a refused turn (`sdk.d.ts` 0.3.311 and the Claude Code 2.1.314 schema text). Recording the cause during the turn and replacing a failed turn end makes the design independent of that order, and keeps one turn-end message per turn, which the queue and the supervisor rely on. A successful turn is never parked, so a stale or late rejection cannot change one.

**The supervisor decides between the two parked states.** The status depends on the resume mode, and `foldSummary` is a pure fold over events. The supervisor owns attention and the per-pane timer slot, so it decides, runs the timer, and re-parks when the mode changes; `foldSummary` and the banner read the decision from the attention tag.

**`AgentSession.resume` instead of `sendText('continue', 'queue')`.** A plain send dispatches the held queue ahead of the new message (`message-queue.ts` `send`, lines 80-83). `resume` puts `continue` first and keeps the `continue` text inside the adapter (Information Hiding).

**One `ResumeParkedAgent { paneId }` command.** Resume all, Retry and the per-tab Resume differ only in which panes they cover; the banner and the transcript pass the panes they show (Strategic Programming).

**The banner derives from agent summaries.** Summaries already reach the renderer (`AgentSummaryChanged`, `GetAgentSummaries`); `parked` on each summary gives the banner its data with no new event.

**A bounded wait with a grace.** A JavaScript timer above 2^31-1 ms fires at once; a reset more than `MAX_AUTOMATIC_WAIT` ahead or already past waits for the user, so a wrong unit or a stale value cannot send `continue` in a loop. `RESUME_GRACE` keeps a timer that fires slightly early from meeting the same limit.

## Rejected Alternatives

**One parked tag with a nullable `resumesAt`.** A signed-out pane with a resume time would be representable (Define Errors Out of Existence). Rejected for `ParkedToResume` and `ParkedForUser`.

**A sixth status for every park, coloured by mode.** One tag whose rank and colour depend on a field. Rejected for `StatusParked` plus `StatusNeedsInput`.

**A separate host service for parking.** It would need to write attention, which the supervisor owns. Rejected.

**`sendText('continue', 'queue')`.** Runs held prompts before `continue`. Rejected.

**The RPC handler stores the setting, then tells the supervisor.** Two calls the handler must make in order (Avoid Temporal Decomposition). Rejected for `PaneSupervisor.setUsageLimitResume`.

**Remembering the reset the last automatic `continue` was sent for.** Needs per-pane state and a rule for clearing it. Rejected for `RESUME_GRACE` plus the past-reset rule in `resumesAtFor`.

## Unverified

- The unit of `rate_limit_info.resetsAt`. The Claude Code 2.1.314 schema text states unix epoch seconds for the per-window `resetsAt`; the top-level field comes from the same `anthropic-ratelimit-unified-*` headers. Check a captured event in Verify.
- That `continue` uses fresh credentials after the user signs in, without restarting the session.
- `error: 'rate_limit'` on an API-key account is a 429, not a plan usage limit, and has no `rate_limit_event`; it parks as `ParkedForUser { UsageLimit { resetsAt: null } }` with the copy `Usage limit reached`.

## Refinement Record

**Round 1 — applied**
1. *Correctness (blocker)* — `TurnParked` was not a turn end in `session.ts` `forward` (`isTurnEnd`, `silentResultsRef`, `abortExpectedRef`) or `ENDS_TURN_STATUS`; all four now include it.
2. *Correctness (blocker)* — the queue `resume` transition omitted `steered`, `dispatching` and the `QueueChangedAction`; now built on `dispatchNow`.
3. *Correctness* — interrupt and rewind leave a parked state; `foldSummary` maps `Idle` from parked to `StatusIdle`.
4. *Correctness* — the chat stayed loading while parked; `isTurnOver` includes both parked tags.
5. *Avoid Temporal Decomposition / correctness* — the supervisor had no `SettingsStore`, and the handler had to call two services in order; now `PaneSupervisor.setUsageLimitResume`, with the layer wiring named.
6. *Correctness* — an out-of-range or past `resetsAt` could fire at once and loop; `resumesAtFor` takes `nowMs` and a 7-day bound.
7. *Define Errors Out of Existence* — one `Parked` tag admitted `SignedOut` with a resume time; split into `ParkedToResume` and `ParkedForUser`; `ParkedAgent` deleted.
8. *Correctness* — a stale rejection could park a successful turn; only a failed result parks.
9. *Project rule (cva)* — a still parked dot matched a still working dot; `bg-ink-muted/40`, and the overview's `StatusTag` gains it.
10. *Correctness* — a mode change repeated the transcript notice; the park notice is replaced.
11. *Project rule (ADR-0031)* — named both `plugin-api.ts` files.
12. *Completeness* — `unavailableSession`, `unstartedSession`, `ResumeParkedAgent` RPC, `dia.d.ts`; `PLUGIN_API_VERSION` bump.
13. *Project rule (JSDoc)* — doc lines on every new export.
15. *Names as Documentation* — `settleFiberRef` renamed `timerFiberRef`.
16. *Strategic Programming* — the "reset passed" rule was stated twice; now `awaitsUser`.

**Round 1 — rejected**
- *14, first part* — "OS notifications (none exist)" was called unverified. Rejected: a search of `src/` and `plugins/` found no notification code during exploration; the draft now says so.
- *6, unit claim* — the unit was called wholly unverified. Partly rejected: the Claude Code schema text states seconds for the per-window field; recorded under Unverified for the top-level field.

**Round 2 — applied**
1. *Correctness (blocker), plugin boundary* — the adapter could not build `UsageLimit` or `SignedOut`; both, and `ParkCause`, are exported from `@dia/plugin` with `TurnParked`.
2. *Correctness (blocker)* — the `Idle`-from-parked fold rewrote a resumed agent to idle; `PaneUserMessagesSent` removes `parked`, and the `Idle` row is scoped to a parked status.
3. *Correctness* — the "same reset" repeat rule had no storage or clearing rule; replaced by `RESUME_GRACE` and the past-reset rule.
4. *Correctness* — the `PLUGIN_API_VERSION` bump would refuse the six bundled plugins; their manifests move to `0.0.5`.
5. *Wording* — the parking result condition is unambiguous.
6. *Correctness* — the transitions name the send path out of a park and why `Errored->Parked*` is absent.
7. *Correctness* — `toAttentionTarget` returns none for `TurnParked`; `handleSessionEvent` decides the park.
8. *Correctness* — the layer wiring is stated cycle-free, and test layers provide `SettingsStore`.
9. *Correctness* — the banner and the Resume button read `useAgentSummaries()` and a shared `useNow`.
10. *Correctness* — park notices carry the id suffix `:parked`.
11. *Correctness* — `applyAttention` validates before it interrupts, so a rejected transition keeps the timer.
12. *Project rule (logging)* — the log points are named.
13. *Project rule (schemas, JSDoc)* — banner variants are named `TaggedStruct`s with `.make`.
14. *Wording* — the status-indicator and `statusRank` JSDoc are updated.

**Round 3 — applied** (no blocker or major found; the loop stops here)
1. *Correctness* — fractional seconds would fail `Schema.Int`; the reducer rounds.
2. *Wording* — the `continue` user row after a resume is stated as intended.
3. *Correctness* — an unknown reset read "Usage limit reset"; `LimitUnknownBanner` reads "Usage limit reached · Resume all", and `LimitWaitingBanner.resetsAt` is no longer nullable.
4. *Completeness* — `agent-row.tsx` gets a `StatusParked` case, and one `formatResetTime` serves the banner, notice and row.
5. *Completeness* — `repark(mode)` is returned by `startPane` and stored on `PaneEntry`.
6. *Completeness* — `AgentSession` and `PaneHandle` fakes in tests gain `resume`.

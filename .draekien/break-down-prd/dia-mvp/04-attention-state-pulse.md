# Bullet 04 — Attention State & Pulse Indicators

**Goal:** Every pane's `AttentionState` (waiting on permission / errored / completed) drives a pulse indicator visible across the whole layout, and clicking a pulsing pane focuses it — dimming the other panes rather than resizing the layout — so the user can act on it: the one deliberate loud signal in dia's design.

**Serves these PRD items:**

- US-7: "As a user, I want a pane to pulse amber when its agent is waiting on a permission decision so that I notice it without having to actively watch every pane."
- US-8: "As a user, I want a pane to pulse red on an error and green on completion so that I can tell each pane's status at a glance across the whole layout."
- US-9: "As a user, I want to click a pulsing pane to focus it and have it expand so that I can easily see its context and act on its permission dialog." (superseded in implementation: focus now dims the other panes instead of resizing the layout — see `docs/prds/mvp.md`, which still has the original wording and should be updated to match)
- G-4: "Every pane's attention state... is visually reflected via its pulse indicator with no missed or incorrect state observed during testing."

## Tasks

- [x] **T1** [AFK] Implement the `AttentionState` `Schema` and pure transition logic: `Idle → AwaitingPermission → Idle`, `Idle → Errored`, `Idle → Completed → Idle` (§3) — serves: US-7, US-8 — depends: —
- [x] **T2** [AFK] Automated tests for every valid `AttentionState` transition and rejection of invalid ones — serves: G-4 — depends: T1
- [x] **T3** [AFK] Wire `AgentSession`/`PaneSupervisor` to emit `AttentionState` changes on permission-request/error/completion events and publish `PaneAttentionChanged` via `IpcGateway` (§4.2 step 4, §4.3, §6) — serves: US-7, US-8 — depends: T1
- [x] **T4** [AFK] Renderer: pulse indicator component driven by `AttentionState` (amber/red/green), click-to-focus behavior (dims the other panes rather than resizing the layout), and a `ResolvePermission` command wired to a permission dialog — serves: US-7, US-8, US-9 — depends: T3
- [x] **T5** [HIL] Manual verification: trigger a real permission-required tool call and confirm amber pulse + focus-and-dim + dialog + approve/deny resolution all work; trigger a real error and a real completion and confirm red/green pulses appear correctly — serves: US-7, US-8, US-9, G-4 — depends: T4

## Dependency tree

```mermaid
graph TD
  T1[T1: AttentionState schema + transitions]
  T2[T2: transition unit tests]
  T3[T3: wire session events to AttentionState]
  T4[T4: pulse UI + focus-and-dim + permission dialog]
  T5[T5: manual permission/error/completion verification]
  T1 --> T2
  T1 --> T3
  T3 --> T4
  T4 --> T5
```

## Note on existing plumbing

Some of the wiring T3/T4 need already exists, built ahead of this bullet while extending Effect TS into `agent-session.ts` (ADR-0010): `protocol.ts`/`contract.ts` carry `PermissionRequested`/`ResolvePermission` messages end-to-end, and `agent-session.ts` suspends `canUseTool` on an Effect `Deferred` until a `ResolvePermission` message resolves it. None of this is wired to an `AttentionState` yet (that schema doesn't exist) and there is no renderer UI — T1 (the `AttentionState` schema itself) and T4's actual dialog/pulse UI are still fully open. T3 can likely consume the existing `PermissionRequested` event rather than adding a new one.

## Human-in-the-loop callouts

- **T5** — Whether the pulse actually appears correctly, on time, and is missed or not can only be judged by watching a real permission prompt / error / completion happen against a real local Claude Code session; this is blocked-on-info (the SDK's real event timing/shape isn't fully known until observed) and is exactly what G-4 requires to be demonstrated by a human, not asserted.

## Done when

Across a multi-pane layout, a real permission request pulses its pane amber, a real error pulses red, a real completion pulses green, and clicking any pulsing pane focuses it — dimming the other panes — with its permission dialog actionable — with no missed or incorrect state observed.

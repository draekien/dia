# dia MVP — Tracer-Bullet Breakdown

**Source PRD:** `docs/prds/mvp.md` (technical spec: `docs/tech-specs/mvp.md`)

## Bullets (in execution order)

Bullets run in sequence; each is demoable on completion.

1. [Bullet 01 — Single-Pane Walking Skeleton](01-single-pane-walking-skeleton.md) — one pane runs a real Agent SDK session in its own `utilityProcess`, end-to-end through Effect orchestration and IPC.
2. [Bullet 02 — Multi-Pane Split Layout](02-multi-pane-split-layout.md) — the pane becomes a splittable, resizable tree of fully independent sessions, scaling to 6+ panes.
3. [Bullet 03 — Working Directory Picker & Worktree Management](03-working-directory-and-worktrees.md) — creating a pane offers a native directory picker and an optional isolated git worktree, auto-removed on pane close.
4. [Bullet 04 — Attention State & Pulse Indicators](04-attention-state-pulse.md) — amber/red/green pulses reflect each pane's state, with click-to-focus/expand.
5. [Bullet 05 — Persistence & Restart Restore](05-persistence-restart-restore.md) — layout and per-pane history survive an app restart with zero data loss.
6. [Bullet 06 — Richer Permission Responses & Clarifying Questions](06-richer-permission-responses-and-questions.md) — the permission dialog supports modify/deny-with-message/always-allow/redirect, and `AskUserQuestion` gets its own answerable card.
7. [Bullet 07 — Streaming Text & Tool-Call Activity](07-streaming-text-and-tool-activity.md) — assistant text streams incrementally (already implemented) and a running-tool indicator closes the preload/renderer gap for tool-call events.
8. [Bullet 08 — Permission Mode Selection](08-permission-mode-selection.md) — a pane's permission mode is chosen at creation and changeable mid-session.
9. [Bullet 09 — Pending-Request Persistence Across Restart](09-pending-request-restart-persistence.md) — a permission or clarifying-question prompt left pending survives quitting and relaunching dia.
10. [Bullet 10 — Dogfooding Milestone](10-dogfooding-milestone.md) — William uses dia on real development work, including on dia's own repo, replacing his prior workflow.

## Task summary

- **AFK:** 46
- **HIL:** 11
- **Total:** 57

## Coverage check

Every PRD user story and measurable goal maps to at least one task. Any item marked UNCOVERED is a gap to resolve, not to ship.

| PRD item | Covered by |
|----------|------------|
| US-1: split workspace into multiple panes | B02/T1, T4, T6 |
| US-2: split any pane further, either direction | B02/T1, T4, T6 |
| US-3: each pane runs a fully independent session | B01/T2, T3, T4, T6, T8; B02/T3, T5, T6 |
| US-4: choose cwd via directory picker, set model at creation | B01/T2, T8 (config plumbing); B03/T1, T5, T6, T7 (picker UI) |
| US-5: optional isolated git worktree per pane | B03/T1, T2, T4, T5, T6, T7 |
| US-6: worktree automatically cleaned up on pane close | B03/T2, T3, T4, T7 |
| US-7: amber pulse on awaiting permission | B04/T1, T3, T4, T5 |
| US-8: red pulse on error, green on completion | B04/T1, T3, T4, T5 |
| US-9: click pulsing pane to focus/expand | B04/T4, T5 |
| US-10: layout and history persist across restarts | B05/T2, T3, T4, T6 |
| US-11: answer AskUserQuestion, including free text | B06/T2, T3, T5, T8 |
| US-12: edit tool input before approving | B06/T1, T3, T4, T8 |
| US-13: "always allow" a kind of call from the dialog | B06/T1, T2, T3, T4, T8 |
| US-14: deny with an explanation | B06/T1, T3, T4, T8 |
| US-15: redirect entirely with a new instruction | B06/T2, T6, T7, T8 |
| US-16: pending prompt survives an app restart | B09/T2, T3, T5 |
| US-17: assistant text streams incrementally | B07/T1, T5 |
| US-18: running tool is visible | B07/T2, T3, T5 |
| US-19: choose permission mode at pane creation | B08/T1, T2, T4, T6 |
| US-20: change permission mode mid-session | B08/T1, T3, T4, T6 |
| G-1: dogfooding milestone reached | B01/T7 (substrate correctness), B10/T1 (the milestone itself) |
| G-2: 6+ concurrent panes, no perceptible lag | B02/T6 |
| G-3: 100% layout/history restore, zero data loss | B05/T6 |
| G-4: attention state always correctly reflected | B04/T2, T5 |
| G-5: zero orphaned worktrees across create/close cycles | B03/T3, T4, T7 |
| G-6: clarifying questions answerable, zero malformed/dropped answers | B06/T7, T8 |
| G-7: all four permission-response types correct | B06/T7, T8 |
| G-8: pending prompt survives restart, zero lost, 3+ runs | B09/T4, T5 |
| G-9: streaming text + tool activity, no drops/out-of-order/batching | B07/T1, T4, T5 |
| G-10: every permission mode selectable + correct, at creation and mid-session | B08/T5, T6 |

The PRD's one Open Question (on-disk layout for per-pane history files — one file per pane vs. combined) does not block any task above; the tech spec explicitly defers it to implementation time within Bullet 05/T1 without affecting the `Schema`/service boundary. The PRD's second Open Question (what a pane shows while a `UserInputRequest` is deferred across a restart) is the explicit subject of Bullet 09/T1's spike, not a blocker to sequencing it.

## Risks (attacked first)

- **Agent SDK + Effect TS fiber/scope lifecycle inside an Electron `utilityProcess` is unproven** (novel combination of ADR-0003, ADR-0007, ADR-0009; nothing in the codebase has run this stack together yet) — addressed first, in Bullet 01, by building the single-pane vertical slice before any multi-pane, persistence, or pulse logic is layered on top of it.
- **"No perceptible input lag" at 6 concurrent panes (G-2) is a real scaling risk**, not just a feature — addressed in Bullet 02 by scaling the Bullet 01 substrate to N independent fibers before adding UI polish (pulse, persistence) on top.
- **Crash isolation (ADR-0007's core guarantee) is easy to get wrong silently** — addressed in Bullet 02/T5 with an explicit simulated-crash test before the manual 6-pane verification, so isolation is checked before scale is checked.
- **Worktree cleanup silently failing to run is the same class of risk as crash isolation** — G-5 demands zero orphaned worktrees, and a leaked `acquireRelease` (e.g. on a process crash path bypassing the worktree's own release) would fail silently until a human noticed stale directories — addressed in Bullet 03/T3 and T4 by testing the release path independently of process success/failure, before the manual multi-cycle verification in T7.
- **The `defer` hook's persisted-state and resume mechanics are the tech spec's explicit open question (§9) — the biggest unknown of the new bullets** — addressed by isolating it into a single named spike (Bullet 09/T1) before any persistence or restore logic is designed around an assumption of how it works.

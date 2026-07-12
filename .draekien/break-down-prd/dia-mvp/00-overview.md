# dia MVP — Tracer-Bullet Breakdown

**Source PRD:** `docs/prds/mvp.md` (technical spec: `docs/tech-specs/mvp.md`)

## Bullets (in execution order)

Bullets run in sequence; each is demoable on completion.

1. [Bullet 01 — Single-Pane Walking Skeleton](01-single-pane-walking-skeleton.md) — one pane runs a real Agent SDK session in its own `utilityProcess`, end-to-end through Effect orchestration and IPC.
2. [Bullet 02 — Multi-Pane Split Layout](02-multi-pane-split-layout.md) — the pane becomes a splittable, resizable tree of fully independent sessions, scaling to 6+ panes.
3. [Bullet 03 — Attention State & Pulse Indicators](03-attention-state-pulse.md) — amber/red/green pulses reflect each pane's state, with click-to-focus/expand.
4. [Bullet 04 — Persistence & Restart Restore](04-persistence-restart-restore.md) — layout and per-pane history survive an app restart with zero data loss.
5. [Bullet 05 — Dogfooding Milestone](05-dogfooding-milestone.md) — William uses dia on real development work, including on dia's own repo, replacing his prior workflow.

## Task summary

- **AFK:** 21
- **HIL:** 5
- **Total:** 26

## Coverage check

Every PRD user story and measurable goal maps to at least one task. Any item marked UNCOVERED is a gap to resolve, not to ship.

| PRD item | Covered by |
|----------|------------|
| US-1: split workspace into multiple panes | B02/T1, T4, T6 |
| US-2: split any pane further, either direction | B02/T1, T4, T6 |
| US-3: each pane runs a fully independent session | B01/T2, T3, T4, T6, T8; B02/T3, T5, T6 |
| US-4: per-pane cwd and model | B01/T2, T8 |
| US-5: amber pulse on awaiting permission | B03/T1, T3, T4, T5 |
| US-6: red pulse on error, green on completion | B03/T1, T3, T4, T5 |
| US-7: click pulsing pane to focus/expand | B03/T4, T5 |
| US-8: layout and history persist across restarts | B04/T2, T3, T4, T6 |
| G-1: dogfooding milestone reached | B01/T7 (substrate correctness), B05/T1 (the milestone itself) |
| G-2: 6+ concurrent panes, no perceptible lag | B02/T6 |
| G-3: 100% layout/history restore, zero data loss | B04/T6 |
| G-4: attention state always correctly reflected | B03/T2, T5 |

The PRD's one Open Question (on-disk layout for per-pane history files — one file per pane vs. combined) does not block any task above; the tech spec explicitly defers it to implementation time within Bullet 04/T1 without affecting the `Schema`/service boundary.

## Risks (attacked first)

- **Agent SDK + Effect TS fiber/scope lifecycle inside an Electron `utilityProcess` is unproven** (novel combination of ADR-0003, ADR-0007, ADR-0009; nothing in the codebase has run this stack together yet) — addressed first, in Bullet 01, by building the single-pane vertical slice before any multi-pane, persistence, or pulse logic is layered on top of it.
- **"No perceptible input lag" at 6 concurrent panes (G-2) is a real scaling risk**, not just a feature — addressed in Bullet 02 by scaling the Bullet 01 substrate to N independent fibers before adding UI polish (pulse, persistence) on top.
- **Crash isolation (ADR-0007's core guarantee) is easy to get wrong silently** — addressed in Bullet 02/T5 with an explicit simulated-crash test before the manual 6-pane verification, so isolation is checked before scale is checked.

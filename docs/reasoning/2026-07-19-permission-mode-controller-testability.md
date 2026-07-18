# Live permission mode + plan restore, and why the controller is its own module

**Date:** 2026-07-19

## Context

Bullet 08 adds a per-pane permission mode chosen at creation and changeable live
mid-session. Two behaviours needed a home in the pane subprocess: applying a mode
to the running SDK query, and — because `plan` is only reachable via the live
switcher (never at creation) — restoring the pre-plan mode when the agent's
`ExitPlanMode` call is approved. The plan's T5 asked for a test driving that
restore round-trip "with a fake `Query`".

## Reasoning / Learning

Unlike the thinking level (frozen for a query's lifetime, so a change forces a
next-turn resume), the SDK exposes `Query.setPermissionMode(mode)` and applies it
to the *running* session — so a mode change lands on the current turn, no restart.
That distinction is why permission mode lives in its own controller rather than
riding the thinking-level restart path.

The plan-restore rule only works because a pane never starts in `plan`: switching
*into* `plan` records the mode being left, and approval replays it. So the state
the controller must own is exactly `{ currentMode, previousMode, liveQuery }`.

The non-obvious part was testability. `agent-session.ts` runs import-time side
effects — `Effect.runFork(program)` and `port.on('message', …)` at module top
level — so it **cannot be imported in a test** (in a non-utility process
`process.parentPort` is `undefined` and the listener wiring throws on load). Any
per-session logic that needs a unit test therefore has to be extracted into a
side-effect-free factory. That's the same reason `agent-session-reducer.ts` and
`pending-user-input.ts` already exist. The mode logic became
`permission-mode-controller.ts` (`makePermissionModeController`), a factory of
Refs exposing `attachQuery` / `seed` / `currentMode` / `applyMode` / `resolvePlan`,
tested by supplying a fake `Pick<Query, 'setPermissionMode'>` that records calls.

Because the controller now owns the current mode (not `configRef`), the
thinking-level restart reads `controller.currentMode` and resumes the query with
it, rather than the stale `config.permissionMode` the pane was created with.

## Implication

When something in the pane subprocess needs a unit test, extract it as a pure /
Ref-only factory alongside the existing ones and keep `agent-session.ts` as the
thin side-effecting shell that wires them to `port` and the SDK. Don't try to test
`agent-session.ts` directly. When adding SDK-live controls, check
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for a live setter on `Query`
before assuming a change requires a session restart.

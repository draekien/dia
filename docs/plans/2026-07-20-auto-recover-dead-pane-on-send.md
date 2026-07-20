# Plan: Auto-recover a dead pane on send/focus, and surface the recovery

Status: **proposed**
Date: 2026-07-20
Driven by: bug — a pane that exists in the layout but has no live session silently
swallows the user's message. Observed logs:

```
WARN  Dropped SendMessage for unknown pane { paneId: …0001 }
DEBUG resumePane skipped; pane has no session to resume { paneId: …0001 }
DEBUG resumePane skipped; pane has no session to resume { paneId: …0001 }
```

## Problem

A pane restored from disk keeps its `PaneConfig` in the workspace index but its
subprocess (the `PaneHandle`) died with the previous app run. Its config carries
`sessionId === undefined` — the session never got far enough to report an id (it
never ran, or died before init). Such a pane is stuck:

1. **Send is dropped.** `SendMessage` → `wireCommands` `withHandle`
   (`gateway.ts:237`) → `getHandle` returns `None` → the command is logged and
   dropped (`gateway.ts:246`). The user's typed message vanishes; the optimistic
   user bubble stays with nothing following it.
2. **Focus can't revive it.** `FocusPane` → `PaneWorkspace.resumePane`
   (`pane-workspace.ts:359`) early-returns on `sessionId === undefined`
   (`pane-workspace.ts:374-377`) because there is no session to *resume*. It
   never considers starting a *fresh* one, so the handle is never re-created.

The pane is a dead end: you can't send to it (no handle) and focusing won't
revive it (nothing to resume). Only closing and re-creating the pane escapes it.

## Decision

Per the user: **auto-recover, and surface the recovery** (transparent, not
silent). Two behaviours:

- A cold pane with no recorded session should **start a fresh session** on
  focus (normal lazy cold-start; no user-visible notice — nothing was lost).
- A `SendMessage` to a pane with no live handle should **resume/start the
  session and then deliver the message**, and **emit a transcript notice** so
  the user sees that the pane had to be brought back up rather than the message
  appearing to have been handled by an already-running session.

Recovery failures that genuinely can't proceed (working directory gone, spawn
failure) keep their existing `Errored` attention surfacing in `resumePane`
(`pane-workspace.ts:347-357` `emitErrored`) — those are recoverable-with-retry,
not silently swallowed.

`FocusPane` cold-start stays silent; only the send-time recovery emits a notice,
because that is the moment where a message could otherwise look dropped.

## Phase 1 — Fresh-start a sessionless pane in `resumePane`

`src/main/services/pane-workspace.ts` (`resumePane`, ~line 359):

- Remove the `if (sessionId === undefined) { logDebug('skipped'); return }`
  early-return (lines 374-377). Let control fall through to the existing request
  build, where `resume: sessionId` is already `undefined` for a fresh start —
  `supervisor.openPane` with `resume: undefined` starts a new session (exactly
  what `createPane` does, whose request omits `resume`).
- The non-worktree cwd-existence check (lines 379-389) and worktree `Reattach`
  logic (line 397) stay unchanged and apply to the fresh-start case too (a
  worktree created earlier still exists on disk and must be reattached, not
  recreated).
- Replace the removed debug line with a `logDebug` distinguishing fresh-start
  from resume (`resume === undefined ? 'starting a fresh session' : 'resuming'`),
  for traceability.
- Update the `resumePane` JSDoc (`pane-workspace.ts:76`) and the `FocusPane`
  command doc (`contract.ts:187`, "A cold … pane resumes its Agent SDK session")
  to note that a pane with no recorded session is cold-*started* fresh, not
  skipped.

No notice is emitted here — cold-start on focus is normal.

## Phase 2 — Resume-then-deliver for `SendMessage` in the gateway

`src/main/ipc/gateway.ts` (`wireCommands`):

- Add a focused `sendMessageToPane(paneId, text)` helper (do **not** widen the
  shared `withHandle`, so resolve/interrupt/rewind on a dead pane keep their
  current drop-with-warning behaviour — those must not spin up an unwanted
  session as a side effect of, e.g., clicking Deny on a stale card):

  ```
  getHandle(paneId):
    Some(handle) -> deliver(handle)
    None ->
      logInfo('pane has no live session; resuming to deliver message')
      resumePane(paneId, onEvent)          // Phase 1 makes this start fresh if needed
      getHandle(paneId):
        Some(handle) -> onEvent(PaneNotice{paneId, message})   // Phase 3
                        deliver(handle)
        None -> logWarning('Dropped SendMessage; pane could not be resumed')
  ```

  where `deliver(handle) = handle.sendMessage(text).pipe(catchAllCause → logError)`
  (same recovery wrapper `withHandle` uses).
- Route `Match.tag('SendMessage', (c) => sendMessageToPane(c.paneId, c.text))`.
- If `resumePane` fails, it has already emitted `Errored`; the final `None`
  branch only logs (no second surfacing).

## Phase 3 — A transparent notice event

Add a reusable `PaneNotice` event rendered as a transcript `notice` divider
(same row style as the compaction divider), so the recovery is visible.

- `src/shared/ipc/contract.ts`:
  - `export const PaneNotice = Schema.TaggedStruct('PaneNotice', { paneId:
    Schema.UUID, message: Schema.String })` + derived type, with JSDoc.
  - Add to the `IpcEvent` union.
  - Add `onPaneNotice(listener: (event: PaneNotice) => void): () => void` to
    `DiaApi`.
- `src/preload/index.ts`: add the `onPaneNotice` subscriber (mirror
  `onConversationReset`, filtering `event._tag === 'PaneNotice'`).
- `src/renderer/src/lib/pane-chat.ts`:
  - Add `PaneNotice` to the `PaneStreamEvent` union.
  - Reducer case `PaneNotice`: append a `notice`-role message whose single text
    part is `event.message` (reuse the existing notice-row construction used by
    `PaneConversationCompacted`). Update `reducePaneChat`'s JSDoc.
- `src/renderer/src/lib/pane-chat-atoms.ts`: add `window.dia.onPaneNotice(push)`
  to the `paneStreamEvents` subscription list.
- The message copy should be accurate whether the session was freshly started or
  resumed — e.g. **"This pane wasn't running — started its session back up to
  handle this message."** (Do not claim a prior conversation existed.)

The renderer already renders `notice` rows (`pane.tsx` `MessageView`), so no
renderer component change is needed.

## Phase 4 — Tests

- `src/main/services/pane-workspace.test.ts`:
  - **Replace** "resumePane is a no-op when the pane has no recorded session"
    (line 622) — it currently asserts `openPaneCalls === 0`. New assertion:
    `openPane` is called once with `resume === undefined` (fresh start), for the
    sessionless-but-indexed pane. (Default fs `exists` returns true, matching the
    existing cold-pane test at 575.)
  - Keep the `resume: 'restored-session-1'` test (575), the live-handle no-op
    (599), the cwd-gone `Errored` (655), the worktree reattach (689), and the
    open-failure `Errored` (748) as-is — Phase 1 doesn't change them.
- `src/main/ipc/gateway.test.ts`:
  - **Replace** "drops SendMessage for an unknown pane without calling
    sendMessage" (line 266). New test: `getHandle` returns `None` first, then
    `Some(handle)` after `resumePane` runs; assert `resumePane` was called with
    the paneId, `handle.sendMessage` received the text, and a `PaneNotice` event
    was `send`-pushed over `CHANNEL.event`.
  - Add a test: when `getHandle` stays `None` even after `resumePane` (resume
    failed to produce a handle), `sendMessage` is never called and no
    `PaneNotice` is emitted (only a warning is logged).
  - The `FocusPane → resumePane` routing test (299) is unaffected.
- `src/renderer/src/lib/pane-chat.test.ts`: add a `reducePaneChat` case — a
  `PaneNotice` event appends a single `notice`-role row carrying its message and
  leaves `isLoading` unchanged.
- Follow `with-testing-principles` (derive expectations from the spec; each test
  pins one behaviour).

## Phase 5 — Verify, document, commit

- `pnpm typecheck`, `pnpm test`, `pnpm build` green; `pnpm diagnostics` clean.
- **Live verification (required):** after an app restart, focus a restored pane
  that never conversed and confirm it comes alive; send a message to a
  handle-less pane and confirm the message is delivered *and* the "started its
  session back up" notice appears in the transcript. Cross-process resume timing
  is the item not fully unit-provable.
- Reasoning-log entry (`docs/reasoning/`): a workspace-indexed pane with
  `sessionId === undefined` is a cold pane to be fresh-started, not skipped;
  `resume: undefined` through `openPane` is the fresh-start path; send-time
  recovery is surfaced via a `PaneNotice` transcript divider while focus
  cold-start stays silent. Add to `docs/REASONING.md`.
- Conventional-commit messages; commit directly to `main`.

## Path-alias / schema notes

- `PaneNotice` lives in `src/shared` and is platform-neutral (schema only) — no
  new path alias needed (ADR-0013).
- Construct it via `PaneNotice.make({ … })`, never a hand-written `_tag` literal.

## Explicitly out of scope

- Auto-resuming on resolve-permission / resolve-question / resolve-plan-review /
  interrupt / rewind against a dead pane (kept as drop-with-warning — those must
  not start a session as a side effect). Revisit only if a real case appears.
- Reworking the `Errored` (recoverable) vs `Crashed` (terminal) surfacing added
  in the turn-feedback work; this plan reuses `Errored` for genuine
  resume-failures and adds a neutral `notice` for successful recovery.
- Distinguishing "never had a session" from "had one that died before reporting
  an id" — both present as `sessionId === undefined` and are handled identically.

## Sequencing / risk

1 → 2 → 3 → 4 → 5. Phase 1 revives focus; Phase 2 revives send; Phase 3 makes
the send-revival transparent. Main risk is a double session-start race if a
`SendMessage` and a `FocusPane` for the same dead pane are processed close
together — mitigated because `wireCommands` processes commands sequentially
(`Stream.runForEach`) and `resumePane` guards on `getHandle` being `None`, so the
second caller sees the handle the first one registered.

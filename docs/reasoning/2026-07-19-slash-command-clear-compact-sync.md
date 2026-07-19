# Syncing `/clear` and `/compact` from the pane session

**Date:** 2026-07-19

## Context

Adding slash-command support to dia meant surfacing the available commands for
the `/` popover *and* reflecting the two commands that mutate session state —
`/compact` and `/clear` — in the renderer. Wiring the command list was
mechanical; the two mutating commands each hid a non-obvious trap.

## Reasoning / Learning

**The command list comes from `query.supportedCommands()`, not the streamed
`system/init`.** (Superseded the original init-based approach — see the update
below.) `system/init` carries `slash_commands: string[]` — names only, no
descriptions — and is only emitted once the SDK consumes the first prompt, so
relying on it left the popover empty (and description-less) until the user's
first turn. The SDK runs its control-protocol `initialize()` eagerly when
`query()` is constructed; `query.supportedCommands()` awaits that and returns
the full `SlashCommand[]` (name, description, argumentHint) *before any prompt*.
So `agent-session.ts` fires a forked `supportedCommands()` warm-up right after
`query()` on every session start/resume and emits `SlashCommandsAvailable` from
it; the reducer's `init` branch emits only `SessionStarted`. A later
`system/commands_changed` still overwrites the list for mid-session changes
(e.g. skills discovered in a subdirectory). Every list is a full replacement,
not a merge.

> **Update (2026-07-19, later same day):** the initial implementation drove the
> list from the streamed `system/init` message (names only) and expected
> `commands_changed` to enrich it. In practice `commands_changed` rarely fires,
> so descriptions never appeared, and init doesn't arrive until the first
> prompt, so the popover was empty on a fresh pane. Switching to the
> `supportedCommands()` warm-up fixed both. If `supportedCommands()` ever fails,
> the pane simply has no commands until a `commands_changed` arrives — a rare,
> logged degradation.

> **Update (2026-07-19, resume delivery + warming indicator):** the warm-up
> already runs on resume — `runSession` fires it on every `Init`, and resume is
> just an `Init` carrying `resume` (triggered by `FocusPane` →
> `PaneWorkspace.resumePane`). The gap on resume was *delivery*, not discovery:
> `paneChatAtom` fetched history (an async IPC round-trip) *before* forking its
> event subscription, so a warm-up `SlashCommandsAvailable` push landing in that
> window was dropped. Fix: the atom now subscribes *first*, then folds the
> fetched history in while preserving whatever slash-command state the stream
> already delivered (`slashCommands`/`warmingCommands`). This trades an almost
> impossible "streamed delta before history resolves on a just-resumed pane" for
> reliable command delivery — the right trade, since resume doesn't auto-start a
> turn. Separately, a `SlashCommandsWarming { active }` message now brackets the
> warm-up await (`active: true` before, `active: false` on failure; success ends
> it via `SlashCommandsAvailable`), driving a muted "Loading commands…" spinner
> just above the pane input. It stays off the amber/red/green pulse reserved for
> attention (One Voice Rule) and never collides with the `/` popover: while
> warming the command list is empty, so the popover can't open.

**`/clear` must persist the new conversation id or resume silently reloads the
old transcript.** `/clear` surfaces as a top-level `conversation_reset` SDK
message carrying `new_conversation_id`. dia persists the pane's `sessionId` to
resume on focus; if we clear the renderer transcript but *don't* overwrite the
stored session id, the next resume reattaches to the pre-clear session and the
whole transcript reappears. So `pane-supervisor` routes `ConversationReset`
through the same `onSessionId` persistence path a normal `system/init` uses. The
renderer event deliberately omits `newSessionId` (main-only concern); the
renderer just resets to empty state while *keeping* the available command list.

**`conversation_reset` is ambiguous but safe in practice.** It fires not only on
`/clear` but also on plan-mode-exit-with-fresh-session. That would wrongly blank
a pane mid-work — except dia leaves the SDK's `showClearContextOnPlanAccept` at
its default `false`, so plan acceptance does not emit it. This is a standing
assumption: if that option is ever enabled, the reset handler needs to
distinguish the two triggers.

**Compaction is a notice, not a turn.** `/compact` (and auto-compaction) arrive
as `system/compact_boundary` with `{ trigger, pre_tokens, post_tokens? }`.
`post_tokens` is optional, so the renderer notice degrades to just
"Context compacted" when absent. The notice is rendered as a new `notice`-role
`PaneMessage` (a centered divider), a third role alongside `user`/`assistant`.
Token counts are interpolated as plain numbers, **not** `toLocaleString()` —
locale/ICU-dependent formatting would make the pure reducer test non-deterministic.

## Implication

- Keep the SDK→protocol mapping in the pure `agent-session-reducer.ts` and the
  protocol→IPC mapping in `pane-supervisor.ts`; both are unit-tested without a
  live session.
- If `showClearContextOnPlanAccept` is ever turned on, revisit the
  `conversation_reset` handler — it will start blanking panes on plan accept.
- The `/` popover follows the WAI-ARIA combobox pattern (focus stays in the
  textarea, options driven by `aria-activedescendant`); Biome's a11y rules don't
  model it, so the option elements carry justified `biome-ignore` lines rather
  than being made focusable.

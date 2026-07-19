# Syncing `/clear` and `/compact` from the pane session

**Date:** 2026-07-19

## Context

Adding slash-command support to dia meant surfacing the available commands for
the `/` popover *and* reflecting the two commands that mutate session state —
`/compact` and `/clear` — in the renderer. Wiring the command list was
mechanical; the two mutating commands each hid a non-obvious trap.

## Reasoning / Learning

**Two SDK messages describe the command list, not one.** `system/init` carries
`slash_commands: string[]` — names only, no descriptions. A later
`system/commands_changed` carries `SlashCommand[]` with `description` and
`argumentHint`. So the shared `SlashCommandInfo { name, description,
argumentHint }` is populated name-only from init (empty hint/description
strings) and *enriched* when `commands_changed` arrives. Both are treated as a
full replacement set, not a merge — the reducer just overwrites `slashCommands`.

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

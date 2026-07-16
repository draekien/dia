# Bullet 06 — Richer Permission Responses & Clarifying Questions

**Goal:** A pane's permission dialog stops being a binary allow/deny — the user can edit a tool's input before approving, mark a kind of call "always allow", deny with an explanation, or redirect Claude entirely with a new instruction — and a parallel clarifying-question flow lets Claude ask multiple-choice questions (with free text) through the same `canUseTool` path.

**Serves these PRD items:**

- US-11: "As a user, I want to answer Claude's multiple-choice clarifying questions, including typing my own answer when none of the options fit, directly from the pane so that I can guide a task with multiple valid approaches without it being treated as a tool permission prompt."
- US-12: "As a user, I want to edit a tool's proposed parameters before approving it so that I can allow an action scoped exactly the way I want instead of denying it outright."
- US-13: "As a user, I want to mark 'always allow' for a specific kind of tool call from the permission dialog so that I stop being re-prompted for that same category of action in that pane going forward."
- US-14: "As a user, I want to deny a tool request with an explanation of what I'd prefer instead so that Claude adjusts its next attempt rather than repeating the same blocked action."
- US-15: "As a user, I want to send Claude a brand new instruction while a permission or question prompt is pending so that I can redirect it entirely instead of only being able to respond to the current request."
- G-6: "Every clarifying question Claude asks (via `AskUserQuestion`), including free-text answers, is answerable from the pane UI with zero malformed or dropped answers observed during testing."
- G-7: "All four permission-response types (allow as-is, allow with modified input, deny with a message, allow-and-remember) are each exercised at least once during manual testing and correctly change the tool's execution or Claude's next action, with zero incorrect behavior observed."

## Tasks

- [ ] **T1** [AFK] Generalize `AwaitingPermission`'s payload into the `UserInputRequest` `Schema` union (`PermissionRequest` | `ClarifyingQuestion`), and add `PermissionResponse` (`Allow`/`Deny`) and `QuestionResponse` (`Answers`/`FreeformResponse`) `Schema`s (§3) — serves: US-11, US-12, US-13, US-14 — depends: (Bullet04/T1)
- [ ] **T2** [AFK] Extend `AgentSession`'s `canUseTool` to branch on `toolName === "AskUserQuestion"`, emitting a `ClarifyingQuestion` request instead of a `PermissionRequest`, and to pass through `suggestions`/`updatedPermissions` for an "always allow" rule (§4.3) — serves: US-11, US-13 — depends: T1
- [ ] **T3** [AFK] Add the `ResolveQuestion` IPC command and route `PermissionResponse`/`QuestionResponse` end-to-end through `contract.ts`, `protocol.ts`, and the preload bridge — serves: US-11, US-12, US-13, US-14 — depends: T1, T2
- [ ] **T4** [AFK] Renderer: extend the permission dialog with an editable input field before allowing, a required message field when denying, and an "always allow this kind of call" toggle that echoes a `suggestions` entry back as `updatedPermissions` — serves: US-12, US-13, US-14 — depends: T3
- [ ] **T5** [AFK] Renderer: new clarifying-question card — render `questions[]` as radio groups (or checkboxes when `multiSelect`) plus an "Other" free-text option per question, and submit via `ResolveQuestion` — serves: US-11 — depends: T3
- [ ] **T6** [AFK] Wire the pane's existing `SendMessage` path so sending a message while a `UserInputRequest` is pending forwards a new instruction to the SDK's streaming input and leaves the pending `Deferred` to be dropped once the SDK moves on (§4.3) — serves: US-15 — depends: T2
- [ ] **T7** [AFK] Automated tests: `PermissionResponse`/`QuestionResponse` `Schema` encode/decode round trips (including `multiSelect` arrays and free text in place of a label), and a test confirming a redirect leaves the pending `Deferred` unresolved rather than double-resolving it — serves: G-6, G-7 — depends: T1, T6
- [ ] **T8** [HIL] Manual verification against a real session: exercise each `PermissionResponse` variant (allow, allow with modified input, deny with message, allow-and-remember) and confirm each changes Claude's behavior as documented; answer a real `AskUserQuestion` prompt including free text and a `multiSelect` question; redirect a pane mid-prompt with a new instruction and confirm Claude follows it instead of the original request — serves: US-11, US-12, US-13, US-14, US-15, G-6, G-7 — depends: T4, T5, T6

## Dependency tree

```mermaid
graph TD
  B04[Bullet 04: AttentionState + permission dialog]
  T1[T1: UserInputRequest/PermissionResponse/QuestionResponse schemas]
  T2[T2: canUseTool branches on AskUserQuestion]
  T3[T3: ResolveQuestion command + end-to-end wiring]
  T4[T4: dialog supports modify/deny-message/remember]
  T5[T5: clarifying-question card UI]
  T6[T6: redirect via SendMessage]
  T7[T7: automated schema + redirect tests]
  T8[T8: manual verification]
  B04 --> T1
  T1 --> T2
  T2 --> T3
  T3 --> T4
  T3 --> T5
  T2 --> T6
  T1 --> T7
  T6 --> T7
  T4 --> T8
  T5 --> T8
  T6 --> T8
```

## Human-in-the-loop callouts

- **T8** — Whether each permission-response variant and the clarifying-question/redirect flows actually behave as documented against a real Agent SDK session (correct tool execution, correct Claude-side adjustment, correct redirect takeover) can only be judged by observing a real session; this is blocked-on-info (the SDK's real behavior isn't fully knowable until exercised) and is exactly what G-6/G-7 require to be demonstrated by a human, not asserted.

## Done when

Across a real session, a user can allow a tool call as-is, allow it with edited input, deny it with an explanation Claude visibly adjusts to, and mark a kind of call "always allow" so it stops re-prompting; a real `AskUserQuestion` call is answerable including free text and multi-select; and sending a new message while a request is pending redirects Claude instead of just resolving the original request.

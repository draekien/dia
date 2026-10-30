---
status: "accepted"
date: 2026-10-30
decision-makers: William Pei
---

# Park a turn the account refused instead of failing it, and resume it with `continue`

## Context and Problem Statement

When the account refuses a turn (the plan's usage limit is reached, or Claude Code is signed out), dia showed the turn as failed and held the message queue. The user had to notice the failure, wait for the reset and type a message to continue. How should dia treat a refused turn so the agent continues without the user watching it (PRODUCT.md principle 3)?

## Decision Drivers

* An agent out of view keeps working without the user watching it.
* The Agent SDK (0.3.311) does not document which message ends a refused turn.
* The queue and the pane supervisor rely on exactly one turn-end message per turn.
* Held queued prompts must run after the resumed turn, not before it.

## Considered Options

* Park the turn: the adapter ends a refused turn with `TurnParked { cause }`, and the pane supervisor keeps it parked until the reset or the user resumes it.
* Keep the failure, and add a separate "usage limit" event that the renderer shows next to it.
* Resume with `sendText('continue', 'queue')`.

## Decision Outcome

Chosen option: "Park the turn", because it keeps one turn end per turn and does not depend on the order in which the SDK sends the refusal and the result: the reducer records the cause during the turn and replaces only a failed result with `TurnParked`.

The pane supervisor decides between `ParkedToResume` (dia sends `continue` at the reset plus 5 seconds, when the reset is at most 7 days ahead and the user chose to resume automatically), `ParkedUntilReset` (the user resumes it, but not before the reset; the supervisor moves it to `ParkedForUser` at the reset) and `ParkedForUser` (the user resumes it from the account banner or the tab). Only `ParkedForUser` shows as needs input, so an agent the user cannot act on yet never shows amber. `AgentSession.resume` dispatches `continue` ahead of the held queue. The design is in `docs/designs/parked-agents.md`.

### Consequences

* Good, because a usage limit no longer needs the user when it resets: the agent continues on its own.
* Good, because a successful turn is never parked, so a stale rejection cannot change one.
* Bad, because `AgentSession` gained a required member, so the plugin API version moved to `0.0.5` and every plugin manifest with it.
* Bad, because the parked state lives in memory: an agent parked when dia quits comes back idle and nothing resumes it (#69).

## Pros and Cons of the Options

### Keep the failure and add a separate event

* Good, because the queue and the supervisor stay unchanged.
* Bad, because the event's order relative to the result is undocumented, so the renderer cannot tell which failure it belongs to.
* Bad, because nothing resumes the agent.

### Resume with `sendText('continue', 'queue')`

* Good, because it needs no new session method.
* Bad, because a send from an idle queue dispatches the held messages ahead of the new one (`message-queue.ts` `send`), so the held prompts run before the agent finishes the refused work.

## More Information

* `docs/designs/parked-agents.md` — the module design and its review record.
* #69 — keep a parked state across an app restart.

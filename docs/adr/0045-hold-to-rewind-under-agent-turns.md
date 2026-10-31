---
status: "accepted"
date: 2026-10-31
decision-makers: William Pei
---

# Hold to rewind from a control under the agent turn

## Context and Problem Statement

ADR-0018 places the rewind control on user turns and gates it behind a confirmation dialog. The dialog closes as soon as the rewind is sent, so a rewind that fails shows nothing (issue #105). Where should the rewind control sit, how is an accidental rewind prevented, and where does the user see the rewind's progress and failure?

## Decision Drivers

* A rewind discards later turns and file edits and cannot be undone, so one accidental click must not start it.
* The user must see that a rewind is running and whether it failed.
* The control must read as "go back to this point".

## Considered Options

* Keep the dialog, keep it open while the rewind runs, and show the failure in it
* Rewind on one click from an inline control
* Press and hold an inline control under the agent turn

## Decision Outcome

Chosen option: "Press and hold an inline control under the agent turn", because the 1 s hold prevents an accidental rewind without a dialog, and the same row shows `Rewinding…` and `Rewind failed: …`.

The row under agent turn A rewinds to the checkpoint of the next user turn U, keeping A and discarding U and everything after it. The checkpoint stays anchored to the user turn as ADR-0018 describes: `rewindFiles` takes U's uuid and `resumeSessionAt` takes A's uuid. This supersedes ADR-0018's sentence that the control is anchored to user turns and gated behind a confirmation dialog; the rest of ADR-0018 stands.

### Consequences

* Good, because a failed rewind is shown in the row where it was started.
* Good, because no dialog interrupts the transcript.
* Bad, because no control rewinds to before the first user turn; `/clear` starts an empty conversation instead, and does not restore files.
* Bad, because a press and hold is less discoverable than a click; the button's accessible name says `press and hold`.

## Pros and Cons of the Options

### Keep the dialog and show the failure in it

* Good, because the confirmation step is familiar.
* Bad, because the dialog must stay open for the length of the rewind, blocking the pane.

### Rewind on one click from an inline control

* Good, because it is the fastest.
* Bad, because one misclick on a hover-revealed button discards file edits.

## More Information

Design: `docs/designs/rewind-inline-hold.md`. Supersedes part of ADR-0018 (its "Rewind is a manual action anchored to user turns … gated behind a confirmation dialog" sentence).

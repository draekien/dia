---
status: "superseded by ADR-0074"
date: 2026-11-02
decision-makers: William Pei
---

# The Host keeps each tab's chat state and serves snapshots

## Context and Problem Statement

[ADR-0015](0015-effect-atom-and-direct-ipc-reducer-for-renderer-chat-state.md) (amended by
[ADR-0030](0030-user-turns-appear-when-the-host-reports-them-sent.md)) holds a tab's chat state in
a renderer atom that folds live pane events, and seeds a new atom from the transcript. The atom is
disposed 30 s after its tab is hidden, and a tab that runs without being shown has no atom. The
transcript holds one text part per turn, so a rebuilt atom loses the running-turn flag, streaming
text, thinking and tool-call parts, the task list, background tasks, slash commands, the turn-status
label, compaction failure, setup steps and attention. How does a tab show its full state when the
user opens it?

## Decision Drivers

* A tab opened at any time shows the same state it would show if it had been open all along.
* The renderer reconnect path (per-pane sequence numbers and replay in `EventHub`) stays the one
  way the renderer catches up.
* No transcript is read at Host startup for tabs nobody opens.

## Considered Options

* The Host folds each tab's events into its chat state and serves a snapshot with the sequence
  number it covers.
* Mount every tab's atom at renderer startup and keep it until the tab closes.
* Keep an atom alive only while its tab's agent is running (t3code's `RunningThreadKeepAlive`).

## Decision Outcome

Chosen option: "The Host folds each tab's events into its chat state and serves a snapshot",
because it is the only option that also covers a tab that ran before the renderer subscribed and a
renderer reload. It follows t3code's snapshot-then-tail scheme.

`PaneChatProjection` (`src/host/services/pane-chat-projection.ts`) follows the `EventHub` and folds
each pane event with `reducePaneChat`, which moves to `src/shared/domain/pane-chat.ts`. A tab's
entry is seeded from its transcript before any session for it starts, so the transcript holds no
turn the session's events also add. `GetPaneChat` returns `{ state, seq }`. The renderer atom
queues the pane's frames, applies the snapshot, and folds only frames with a higher `seq`. The
renderer atom from ADR-0015 stays; its seed is the Host snapshot instead of the transcript. The
design is in `docs/designs/pane-chat-projection.md`.

### Consequences

* Good, because a tab shows its running turn, tool calls, task list, background tasks, slash
  commands and attention whenever it is opened.
* Good, because the renderer atom keeps no merge rules: the snapshot replaces its state.
* Bad, because the Host holds the chat state of every tab that has been opened or has run since it
  started, until the tab leaves the workspace.
* Bad, because a parked notice in a snapshot is formatted in the Host's locale, and part timestamps
  in a snapshot are the Host's fold time.
* Neutral, because turns from before the Host started still come from the text-only transcript.

## Pros and Cons of the Options

### Mount every tab's atom at renderer startup

* Good, because it needs no Host change.
* Bad, because it reads every tab's transcript at startup.
* Bad, because a renderer reload still loses state.

### Keep an atom alive only while its agent runs

* Good, because it is a small renderer change.
* Bad, because a tab that ran before the renderer first opened it, and a renderer reload, still
  lose state.

## More Information

* Amends ADR-0015 and ADR-0030: the atom's seed changes; its event fold and sending do not.

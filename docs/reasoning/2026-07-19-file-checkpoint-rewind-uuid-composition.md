# File-checkpoint rewind: one message uuid, two SDK mechanisms

**Date:** 2026-07-19

## Context

Implementing transcript-anchored rewind (ADR-0018): a user clicks "rewind to
here" on a past user turn and both the files *and* the conversation must return
to that point. The Agent SDK exposes file checkpointing (`enableFileCheckpointing`
+ `query.rewindFiles(userMessageId)`) and conversation forking (`resumeSessionAt`
+ `forkSession`) as separate features, and it was not obvious how they compose,
what identifier ties them together, or in what order to invoke them.

## Reasoning / Learning

- **Two uuids anchor the two mechanisms — NOT one (corrected 2026-07-19).** The
  original design passed the *same* user-turn uuid to both `rewindFiles(uuid)`
  and `resumeSessionAt: uuid`. That is wrong: `resumeSessionAt` requires an
  **assistant** message uuid, so a user uuid fails silently and the forked
  session never starts (symptom: messages after the point stay visible and the
  next prompt goes nowhere). Each rewindable user turn now carries two uuids —
  its own `checkpointUuid` (→ `rewindFiles`) and the *preceding assistant* turn's
  `resumeAnchorUuid` (→ `resumeSessionAt`). Rewinding the first turn (no
  preceding assistant) starts a fresh, unresumed session. Both live (reducer
  tracks the last assistant uuid seen) and restored (`transcript-reader` tracks
  it while projecting history) paths compute `resumeAnchorUuid` the same way, and
  it is threaded alongside `checkpointUuid` through protocol/IPC to the renderer
  and back in the rewind command.
- **`replay-user-messages` is mandatory, not optional.** Those user-turn uuids
  only reach dia via the query stream as `SDKUserMessageReplay` messages, which
  the SDK emits only when started with `extraArgs: { 'replay-user-messages': null }`.
  Without it, no `CheckpointAvailable` ever fires and no turn is rewindable — the
  feature silently does nothing. The reducer treats *string-content* user messages
  as checkpoint anchors and ignores array-content ones (tool results).
- **Rewind files on the live query first, then fork.** dia rewinds files on the
  still-connected original query, *then* tears down and restarts the pane session
  with `resumeSessionAt`/`forkSession`. This ordering sidesteps an unverified
  question: whether a freshly forked session inherits the parent's checkpoint
  data. Do the file rollback while the session that owns the checkpoints is still
  alive.
- **Two uuid sources, assumed one namespace (restart-survival bridge).** Live,
  the anchor uuid comes off the replay stream. After a restart, the pane's history
  is re-read from the SDK session store via `getSessionMessages`, and each stored
  user turn's `SessionMessage.uuid` is surfaced as `checkpointUuid` so a restored
  pane can still offer rewind on turns it never saw stream live. This relies on
  the replay-stream uuid and the transcript `SessionMessage.uuid` being the *same*
  message-uuid namespace — assumed, not yet verified against a real restarted
  session.
- **Correlate checkpoints FIFO, not "last".** A `CheckpointAvailable` arrives
  *after* its turn is already optimistically rendered, in submission order, so the
  reducer binds each uuid to the *earliest* user turn still lacking one. Turns
  restored from history already carry a uuid and are skipped, which also makes
  replayed uuids on a resumed session idempotent (they match already-anchored
  turns and bind nothing).

## Implication

1. **`resumeSessionAt` semantics — RESOLVED 2026-07-19.** Confirmed: it needs the
   *assistant* uuid, not the user uuid. Fixed by threading `resumeAnchorUuid`
   (the preceding assistant turn) alongside `checkpointUuid`; see the corrected
   first bullet above.
2. **Fork-vs-checkpoint ownership on repeat/earlier rewinds — still unverified.**
   After a fork, the checkpoints belong to the *superseded* session. Rewinding
   again — especially to a turn earlier than the last rewind — may fail because
   that checkpoint no longer belongs to the session now driving the pane. Expect
   edge cases around repeated rewinds after a fork.

Everything above the renderer boundary (`agent-session.ts` rewind sequencing) is
untested by unit tests because that module can't be imported in tests (import-time
`Effect.runFork` + `port.on`); the pure pieces — reducer checkpoint emission
(`agent-session-reducer.ts`), transcript uuid surfacing (`transcript-reader.ts`),
and renderer anchoring/truncation (`pane-chat.ts`) — are covered.

---
status: "accepted"
date: 2026-07-19
decision-makers: William Pei
---

# Transcript-anchored file checkpointing that forks the conversation on rewind

## Context and Problem Statement

The Agent SDK can track file changes made through Write/Edit/NotebookEdit and restore them to a prior point via `rewindFiles(userMessageUuid)`, and it can branch conversation history at a specific message via `resumeSessionAt` + `forkSession`. dia wants to let a user undo an agent's unwanted file changes by rewinding to a known-good point in the pane's transcript. How should rewind behave so that, after it, the agent and the filesystem still agree on the state of the world?

## Decision Drivers

* Rewinding files alone leaves the conversation out of sync with disk — the agent's context still asserts edits that no longer exist, which confuses subsequent turns.
* dia already delegates conversation-transcript persistence to the Agent SDK session store (ADR-0011); a parallel checkpoint/transcript store should be avoided.
* The user-message UUID needed for a checkpoint is already available both from the live stream (`message.uuid`) and from the on-disk session store (`SessionMessage.uuid`, read via the existing `TranscriptReader`), so no new persisted state is required.
* Changes should stay within the established pane-process patterns: the main↔pane `protocol.ts` message unions, the `SessionEventReducer`, and the existing session teardown/restart used for thinking-level changes.

## Considered Options

* **A — Files-only rewind:** call `rewindFiles(uuid)` and leave the conversation intact.
* **B — Files + full-history fork:** `rewindFiles(uuid)` plus `forkSession: true` without `resumeSessionAt`.
* **C — Files + conversation branch anchored to the same user turn:** `rewindFiles(userTurnUuid)` plus `resumeSessionAt` + `forkSession: true` branching at that turn. (`resumeSessionAt` takes the *preceding assistant* message's uuid — see the correction note under Decision Outcome.)
* **D — Build a dia-owned checkpoint/transcript store** keyed to our own snapshots.

## Decision Outcome

Chosen option: **C**, because one rewindable user turn drives both the file restore and the conversation branch, so files on disk and the conversation the agent resumes from are rewound to the same point and stay consistent. It reuses state dia already has (the persisted `sessionId` plus the SDK session store) and the existing restart machinery, keeping the change surgical.

Rewind is a manual action anchored to user turns in the transcript. "Rewind to here" restores files to the state *before* that turn ran and branches the conversation to exclude that turn and everything after it. It is destructive (later conversation and file edits are discarded) and therefore gated behind a confirmation dialog; a dry-run diff preview is explicitly out of scope for the first version.

> **Correction (2026-07-19, post-implementation).** This ADR originally said a *single* UUID — the rewound user turn's — drives both mechanisms. That is wrong: the SDK's `rewindFiles(userMessageUuid)` takes the **user** turn's uuid, but `resumeSessionAt` requires an **assistant** message uuid ("resume up to and including the message with this UUID"). Passing a user uuid to `resumeSessionAt` fails silently and the forked session never starts. The implementation therefore anchors each rewindable user turn with **two** uuids: its own (`checkpointUuid`, for `rewindFiles`) and the *preceding assistant* turn's (`resumeAnchorUuid`, for `resumeSessionAt`). Rewinding the first turn (no preceding assistant) starts a fresh, unresumed session. Because the branch lands at the preceding assistant turn, the rewound user turn itself is excluded from both the forked conversation and the displayed transcript — matching this ADR's "exclude that turn and everything after it". The `resumeAnchorUuid` is a second value threaded alongside `checkpointUuid` through the same channels (SDK stream / session store → protocol → IPC → renderer and back), so it upholds the "no new persisted state" consequence below.

### Consequences

* Good, because the agent never resumes against a filesystem that contradicts its context.
* Good, because no new persisted state is introduced — `sessionId` is already persisted and checkpoint UUIDs come from the SDK session store dia already reads (upholds ADR-0011).
* Good, because it reuses the existing session teardown/restart path and the `ConversationReset { newSessionId }` mechanism for adopting the forked session id.
* Bad, because only Write/Edit/NotebookEdit changes are tracked — edits made via Bash (e.g. `sed -i`) are not undone, so a rewind can leave Bash-made changes in place. This limitation must be surfaced to the user.
* Bad, because enabling `extraArgs: { 'replay-user-messages': null }` changes the live message stream (user messages are replayed with UUIDs); the reducer must be verified to tolerate this without double-rendering.
* Bad, because directory create/move/delete and non-local files are not restored by `rewindFiles` (SDK limitation).

## More Information

* SDK references: [file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md), [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript.md) (`Query.rewindFiles`, `Options.resumeSessionAt`/`forkSession`/`enableFileCheckpointing`, `SessionMessage.uuid`).
* Builds on ADR-0011 (delegate transcript persistence to the SDK session store) and ADR-0007 (one utilityProcess per pane).
* Implementation plan tracked with the session that produced this ADR.

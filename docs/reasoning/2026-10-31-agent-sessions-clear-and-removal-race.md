# `/clear` records a session with no transcript, and project removal's transcript delete is undone

**Date:** 2026-10-31

## Context

Verifying #94 (`agent_sessions` in `host.db`) in an `electron-builder --dir` build with a scratch profile. One prompt was sent in a tab, then `/clear`, then the tab's project was removed.

## Reasoning / Learning

**`/clear` changes `Tab.sessionId` twice.** `agent_sessions` for the tab held three rows after one prompt and one `/clear`:

```text
c93ee055-…  started 1793409938504  superseded 1793409963810   transcript: 43 lines
93fb5958-…  started 1793409963810  superseded 1793409964262   transcript: none
6e4d274d-…  started 1793409964262  current                    transcript: 5 lines
```

The intermediate id arrives first (the `conversation_reset` id that `docs/reasoning/2026-07-19-slash-command-clear-compact-sync.md` persists), and the session the CLI actually writes arrives 452 ms later. No `.jsonl` exists for the intermediate id. `WorkspaceStore` records every id that reaches `Tab.sessionId`, as designed (`docs/designs/workspace-store.md`).

**Removing a project deletes the current transcript, and the closing CLI writes it again.** Removal closes the agent (`AgentItem`), then deletes its transcript (`TranscriptItem`). The Host logged `Deleted transcript` for `6e4d274d-…` at 01:27:06.176Z; at 01:27:06.206Z the tab's exiting `claude` process wrote `atis-latch` and `cost-state` lines, recreating `6e4d274d-….jsonl` as a 3-line, 468-byte file. The removal order in `pane-workspace.ts` predates #94; #94 did not change it.

## Implication

- A reader of `agent_sessions` (#14, #96, #97) must tolerate a session row with no transcript.
- Deleting a transcript while its agent's `claude` process may still be exiting leaves a stub file. Project removal no longer deletes transcripts (ADR-0046, #95), which removes this race. Code that deletes a transcript in future must wait for the agent's process to exit first.

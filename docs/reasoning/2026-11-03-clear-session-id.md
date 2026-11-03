# After `/clear`, the conversation is written under the next `SessionStarted` id

**Date:** 2026-11-03

## Context

Issue #154 records each live pane session to `host.db` and owns the transcript cursor of each conversation the pane starts. A `/clear` in the running app (claude-code adapter, Agent SDK 0.3.311) produced this stream and these transcript files:

| Stream message | Session id | Transcript file under `~/.claude/projects/<encoded-cwd>/` |
| --- | --- | --- |
| `SessionStarted` (pane open) | `203ed869…` | `203ed869….jsonl` |
| `ConversationReset.newSessionId` | `454698ec…` | none |
| `SessionStarted` (right after the reset) | `16d31a3f…` | `16d31a3f….jsonl`, whose first entry is a `SessionStart:clear` hook |

## Reasoning / Learning

- `ConversationReset.newSessionId` comes from the SDK's `new_conversation_id` (`plugins/claude-code/reducer.ts`). No transcript is written under that id. The cleared conversation's entries go to the session named by the `SessionStarted` that follows the reset.
- The recorder first owned the cursor of the `ConversationReset` id only. The following `SessionStarted` then looked like a rewind fork (a new id with no reset), so the recorder dropped ownership and the cleared conversation got no cursor.
- The recorder now keeps a new conversation pending until its first turn end. A `SessionStarted` while it is pending takes ownership. A `SessionStarted` after a finished turn (a rewind fork) does not.

## Implication

- Code that maps a `ConversationReset` to a transcript (catch-up, #155) must not read `newSessionId`'s transcript. Read the transcript of the `SessionStarted` that follows the reset.
- The pane's persisted session id goes through `454698ec…` before it settles on `16d31a3f…` (`onSessionChanged` is called for both). A crash between the two leaves a session id with no transcript.

# The Agent SDK reports a missing resumed session only as text

**Date:** 2026-10-31

## Context

Issue #48: a tab whose stored session id has no transcript crashed on every start. The fix needs the claude-code adapter to tell a missing conversation apart from any other session failure.

## Reasoning / Learning

Resuming a session id that has no transcript (SDK 0.3.311) produces two things, observed in #48:

```text
MESSAGE {"type":"result","subtype":"error_during_execution","num_turns":0,"is_error":true,
         "errors":["No conversation found with session ID: 11111111-…"]}      (no startup_failure_reason)
THROWN  Error: Claude Code returned an error result: No conversation found with session ID: 11111111-…
```

- There is no error code and no `startup_failure_reason`. The only signal is the text of `errors[]`.
- The result arrives before the throw. `session.ts` therefore records the match in a ref and decides the end when the stream stops, whether it throws or completes.
- `num_turns: 0` separates this from a later turn whose error text happens to contain the phrase.
- A rewind resumes with `resumeSessionAt` and `forkSession`. Its `resume` names a conversation that exists, and the SDK text for a missing anchor is unknown, so a rewind never reports `SessionNotFound`.

## Implication

The text match lives only in `isSessionNotFound` (`plugins/claude-code/session.ts`), and the Host branches on `SessionEnd._tag`. If an SDK upgrade changes the wording, the end falls back to `SessionFailed` and the pane is marked `Crashed`, which is the behaviour before #48. Re-check the text after an SDK upgrade: resume a deleted session and read the result message.

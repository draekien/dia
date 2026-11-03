# Resuming a session changes its transcript's mtime without adding entries

**Date:** 2026-11-03

## Context

Catch-up (#155) skips reading a transcript when its size and mtime equal the stored cursor. In the running app (claude-code adapter, Agent SDK 0.3.311), a pane was reopened twice over a transcript that gained no entries between the opens. Both opens read the whole transcript.

| Moment | Transcript size | Transcript mtime (ms) | Cursor mtime (ms) |
| --- | --- | --- | --- |
| Catch-up in `open`, 11:16:47 | 356770 | 1793704581882 | 1793704581882 |
| About 2 s after the resumed session started | 356770 | 1793704609539 | 1793704581882 |

## Reasoning / Learning

- The CLI rewrites the transcript when a resumed session starts. The size can stay the same, while the mtime changes. No main-chain entry is added; the last lines are `last-prompt`, `mode` and `cost-state` records.
- The recorder's turn-end and scope-close cursor update read zero entries after the cursor and wrote nothing, so the cursor kept the mtime from before the rewrite, and the next open read the transcript again.
- The cursor update now writes the new size and mtime under the stored `lastUuid` when the tail has no entries.

## Implication

- A cursor matches its transcript only after a cursor update that runs after the session started: a turn end or a graceful pane close. A pane whose Host process is killed before either one reads its transcript again on the next open, and that read appends nothing.
- Do not treat a changed mtime as proof that a transcript gained entries.

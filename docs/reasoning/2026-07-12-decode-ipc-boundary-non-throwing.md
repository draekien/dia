# Decode messages at process/IPC boundaries with `Either`/`Option`, never `Schema.decodeUnknownSync`

**Date:** 2026-07-12

## Context

Found twice in this codebase: `gateway.ts`'s original `ipcMain` handler and `agent-session.ts`'s original `port.on('message', ...)` handler both called `Schema.decodeUnknownSync(...)` directly inside the message listener.

## Reasoning / Learning

A malformed or unexpected payload arriving over `ipcMain`/`utilityProcess`/`parentPort` message events causes `decodeUnknownSync` to throw synchronously inside the listener callback — there's no calling `Effect` fiber to catch it, so it crashes the whole process (main process or the pane's `utilityProcess`). This is easy to miss because it only surfaces when a real malformed message arrives (a renderer/pane on a mismatched schema version, a manual test with bad data), not during normal development.

## Implication

Any schema decode sitting directly in a raw event-emitter callback (IPC, child process messages, WebSocket frames, etc.) must use `Schema.decodeUnknownEither` or `Schema.decodeUnknownOption` and handle the failure branch (log + drop), never `decodeUnknownSync`. Apply this pattern to any future IPC-like boundary added to `dia` (renderer↔main, main↔pane-process, or any future main↔external-process channel).

# Reading a transcript tail through the Agent SDK, and the `@dia/plugin` event-name collision

**Date:** 2026-11-03

## Context

Issue #153 added `AgentBackend.readTranscriptAfter`, which returns a session's transcript events after an entry uuid and the transcript file's size and mtime (ADR-0051). The issue asked whether `getSessionMessages` with `offset` could replace parsing the JSONL at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

## Reasoning / Learning

- `GetSessionMessagesOptions.offset` counts messages, not uuids, and `getSessionMessages` parses the whole file and follows the `parentUuid` chain on every call (`sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` 0.3.311). Reading "after a uuid" is therefore a full read followed by a slice after the uuid's index. The chain excludes branches a rewind left behind, so a cursor uuid on such a branch is not found; `readTranscriptAfter` then returns every entry, and `AgentEventStore.appendTranscript` skips those already stored.
- `getSessionInfo(sessionId, { dir })` returns `fileSize` and `lastModified`, so no code needs the CLI's `<encoded-cwd>` rule. It returns `undefined` when the file is missing, when the session is a sidechain, and when it has no extractable summary. `fileSize` is set only for local JSONL storage. `sdk.mjs` assigns `lastModified` from an `mtime` field; that it equals the local file's `stat` mtime in milliseconds is not confirmed beyond that.
- The existing `readSessionMessages` in `plugins/claude-code/transcript.ts` turns a read failure into an empty list. A catch-up caller that received an empty list would store the new size and mtime and never retry the unread entries, so `readTranscriptAfter` calls the SDK directly and returns none on failure.
- `src/host/plugin-api.ts` has `export * from './session/protocol'`, which exports `ToolCallStarted` and `ToolCallCompleted` as `OutboundMessage` schemas. `src/shared/domain/agent-event.ts` defines different schemas with the same names. A named re-export of the agent-event schemas would replace the protocol ones for every plugin that imports them from `@dia/plugin`, including `plugins/claude-code/reducer.ts`. The agent-event module is exported as the namespace `AgentEvents` instead.

## Implication

- Plugin code that needs agent-event schemas uses `AgentEvents.<Name>` from `@dia/plugin`.
- Live writes (#154) must use the item-id rule `transcriptEntriesAfter` uses (message: entry uuid; reasoning: `<uuid>:thinking`; tool call: `tool_use` id) and cap output with `capToolOutput`, or an import followed by live writes duplicates items in `agent_items`.

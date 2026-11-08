# An attached session's transcript is pruned on every start

**Date:** 2026-11-08

## Context

The Executive assistant session (ADR-0071) resumed after a restart in the same pane with the stored session id, but its pane showed an empty transcript.

## Reasoning / Learning

`pruneOrphans` in `src/host/services/agent-event-store.ts` runs when the store is built and deletes every `agent_events` and `agent_items` row whose `agent_id` is not in `agents`. A session a plugin attaches (ADR-0070) is never an agent row, so its recorded events are deleted at each start. `agent_transcript_cursors` is keyed by session id and was not pruned, so on resume `AgentEventRecorder.catchUp` found a cursor that matched the transcript file's size and modification time, and imported nothing.

`pruneOrphans` now also deletes each cursor whose session is not in `agent_sessions`. A resumed attached session then re-imports its whole Claude Code transcript through `catchUp`. A workspace tab's sessions are in `agent_sessions`, so its cursors stay; a cursor dropped by mistake only causes a re-read, which `appendTranscript` deduplicates by `source_uuid`.

## Implication

An attached session's pane is rebuilt from its Claude Code transcript on each start, not from dia's event store. Events with no transcript entry, such as `SessionNotice` rows and turn durations, are not restored after a restart.

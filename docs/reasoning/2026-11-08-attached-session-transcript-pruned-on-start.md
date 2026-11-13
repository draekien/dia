# An attached session's transcript was pruned on every start

**Date:** 2026-11-08 (updated 2026-11-13 for the `dia-run-events` plugin, #241)

## Context

The Executive assistant session (ADR-0071) resumed after a restart in the same pane with the stored session id, but its pane showed an empty transcript.

## Reasoning / Learning

`pruneOrphans` in the former `src/host/services/agent-event-store.ts` ran when the store was built and deleted every `agent_events` and `agent_items` row whose `agent_id` was not in `agents`. A session a plugin attaches (ADR-0070) is never an agent row, so its recorded events were deleted at each start. `agent_transcript_cursors` is keyed by session id and was not pruned, so on resume catch-up found a cursor that matched the transcript file's size and modification time, and imported nothing. The fix then was to prune those cursors too, so a resumed attached session re-imported its whole Claude Code transcript.

Since #241 the event log lives in `plugins/dia-run-events/store.ts`, in the plugin's own database. It has no `pruneOrphans`: no event, item or cursor is deleted because its run is not a workspace tab. An attached session's events and its cursor both stay, so a resume shows the stored history and catch-up imports only the transcript entries after the cursor.

## Implication

Do not add a start-up prune keyed on `host.db`'s `agents` table to the run event store: the plugin's database has no `agents` table, and a prune that drops events but keeps cursors brings back this bug. The legacy `host.db` rows are still deleted by the `agents` delete trigger; those rows are no longer read after the one-time copy.

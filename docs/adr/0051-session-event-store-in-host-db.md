---
status: "accepted"
date: 2026-11-02
decision-makers: William Pei
---

# Store each agent's conversation as events in `host.db`, and use the Agent SDK transcript only to resume

## Context and Problem Statement

ADR-0011 made the Agent SDK transcript at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` the only copy of an agent's conversation. ADR-0050 seeds each tab's `PaneChatProjection` once per Host run from that transcript through `TranscriptReader.readHistory`, which calls `getSessionMessages()` and `sessionMessagesToConversation` (`plugins/claude-code/transcript.ts`). That seed is text-only: turns from before the Host started lose their tool calls. Live events exist only in `EventHub`'s in-memory buffer of 1000 events per pane (ADR-0022), which a Host restart clears. Import runs once, when a project is registered (#96). Archive removes the agent's worktree and has no unarchive (`docs/designs/archive-delete-agents.md`). Where should dia keep an agent's conversation so that sessions can be imported and resumed, history loads fast, and agents can be archived and unarchived?

## Decision Drivers

* Import any local Claude Code session into dia and resume it there.
* Performance: opening an agent must not parse its whole transcript, and writes must not stall the Host's single event loop (`node:sqlite` is synchronous, ADR-0042).
* Archive and unarchive an agent, with its transcript readable while archived.
* A reopened or imported agent shows its tool calls, not only its prose.
* The Claude CLI rebuilds model context only from its own JSONL, so `resume: sessionId` must keep working.

## Considered Options

* Conversation events in `host.db`; the SDK JSONL is used only for `resume`
* Persist only the live `EventHub` stream; the SDK JSONL stays the transcript dia renders
* Persist only lifecycle events (imported, archived, unarchived, session bound)

## Decision Outcome

Chosen option: "Conversation events in `host.db`; the SDK JSONL is used only for `resume`", because it is the only option where a history load reads an indexed table, tool calls survive a restart, and archive and unarchive are recorded events.

### Ownership

* dia's events are the source of the conversation dia renders. dia never writes the SDK JSONL. dia passes the JSONL's session id to the SDK as `resume: sessionId` and reads the JSONL only for import and catch-up.
* The stream is the agent, not the SDK session. `/clear` and compaction append `SessionBound{sessionId}` to the same agent stream, and `agent_sessions.superseded_at` (ADR-0043) keeps its current meaning.
* The tables live in the kernel's `host.db`. Events use the provider-neutral `OutboundMessage` shape (`src/host/session/protocol.ts`, ADR-0029). The claude-code adapter supplies JSONL reading through a new `AgentBackend` method that returns transcript entries after a given entry uuid. The adapter does not read or write the event tables (ADR-0042: plugins share data through services).

### Storage shape

ADR-0042's "event table + projection table in one `sql.withTransaction`" shape:

| Table | Purpose | Key columns |
| --- | --- | --- |
| `agent_events` | Append-only event log | `sequence INTEGER PRIMARY KEY AUTOINCREMENT`, `agent_id`, `event_type`, `item_id`, `source_uuid` (SDK message uuid), `occurred_at`, `payload_json`; index `(agent_id, sequence)`; `UNIQUE (agent_id, source_uuid, COALESCE(item_id, ''))` where `source_uuid` is not null |
| `agent_items` | Projection read by history and the renderer | primary key `(agent_id, item_id)`, `position`, `kind` (`message`, `reasoning` or `tool_call`), `streaming`, `payload_json`; unique index `(agent_id, position)` |
| `agent_transcript_cursors` | Catch-up position per SDK session | `session_id` primary key, `last_uuid`, `file_size`, `mtime_ms` |

* An agent's archive state is `agents.archived_at`, set and cleared by the `AgentArchived` and `AgentUnarchived` events in the same transaction.
* Each event insert and its projection upsert commit in one transaction. History reads page `agent_items` by `(agent_id, position)` and never replay `agent_events`.
* `(agent_id, source_uuid, item_id)` is the idempotency key for every event that came from an SDK message, live or imported. An insert whose `agent_id`, `source_uuid` and `item_id` already exist is skipped. `agent_id` is part of the key because an import of a forked session repeats the source session's uuids under another agent. `item_id` is part of the key because one SDK entry yields several events: a user entry holds the `tool_result` of every parallel tool call.
* `agent_items` is keyed by `(agent_id, item_id)` because item ids come from SDK ids, and one session's ids can reach two agents through an import of a forked session.

### Content

| Stored | Not stored |
| --- | --- |
| User and assistant messages | Per-token deltas. Streaming text is coalesced and written as one `MessageUpdated{streaming: true}` per 50 ms flush, then one final `MessageUpdated{streaming: false}` |
| Tool call start and result, with tool output capped in size | Tool output beyond the cap |
| Extended-thinking text, as `ReasoningUpdated` events and `reasoning` items, coalesced like message text | |
| `SessionBound`, `AgentImported`, `AgentArchived`, `AgentUnarchived` | Raw SDK frames |

### Import

* A picker lists every session that the SDK's `listSessions()` returns on this machine, across all directories.
* Importing a session creates an agent. The session's `cwd` is kept byte-identical (`docs/reasoning/2026-07-17-worktree-reattach-resume-incantation.md`). If the `cwd` is a registered project, or lies inside one, the agent joins that project. Otherwise dia registers the `cwd` as a new project first.
* The import writes `AgentImported`, then one event per message and tool call, then `SessionBound`, in transactions of 500 events so that one long transcript does not block the Host event loop in a single commit.
* Project registration (#96) uses the same import path.

### Catch-up on open

* Opening an agent runs `stat` on its current session's JSONL. If `file_size` or `mtime_ms` differs from `agent_transcript_cursors`, dia reads the entries after `last_uuid` through the adapter and appends them, skipping known `source_uuid`s.
* An agent with no cursor row has its whole JSONL imported on first open. Agents created before this ADR need no separate migration step.
* Turns added outside dia, for example by `claude --resume <id>` in a terminal, therefore appear in dia when the agent is next opened.

### Archive and unarchive

* Archive appends `AgentArchived`, stops the session, removes the worktree as before (the branch is kept), and deletes the agent's superseded `MessageUpdated{streaming: true}` events. One final event per message and tool call remains. The archived transcript reads from `agent_items` like an active one.
* Unarchive runs `git worktree add <original path> <kept branch>` and then appends `AgentUnarchived`. Unarchive fails with no event written if the branch no longer exists or the path is occupied. The `cwd` is unchanged, so `resume` finds the JSONL.
* Delete hard-deletes the agent's `agent_events`, `agent_items` and `agent_transcript_cursors` rows. The SDK JSONL is kept (ADR-0046), so the session can be imported again.

### Durability

* `host.db` runs with `journal_mode = WAL` and `synchronous = NORMAL`. A dia crash or kill loses no committed transaction. An OS crash or power loss can lose commits since the last WAL checkpoint ([sqlite.org/pragma.html](https://www.sqlite.org/pragma.html#pragma_synchronous)). Catch-up on open restores lost message events from the JSONL.

### Replay to the renderer

* `PaneEventFrame.seq` becomes the agent's `agent_events.sequence`. `SubscribeEvents` cursors replay from `agent_events` instead of `EventHub`'s in-memory buffer, so replay survives a Host restart.
* `PaneChatProjection.seed` (`src/host/services/pane-chat-projection.ts`, ADR-0050) reads the tab's agent from `agent_items` instead of calling `TranscriptReader.readHistory`. `GetPaneChat` and its `{ state, seq }` snapshot are unchanged, and `seq` is an `agent_events.sequence`.
* When a cursor's replay would exceed a size limit, the Host sends `ReloadHistoryFrame` and the renderer requests a new `GetPaneChat` snapshot instead. T3 Code uses 128 events or 1 MiB (`apps/server/src/orchestration-v2/ThreadStream.ts`). dia's limit is set at implementation.

### Consequences

* Good, because opening an agent reads one page from `agent_items` by index instead of parsing the whole JSONL. <!-- unverified: the current getSessionMessages parse time has not been measured -->
* Good, because tool calls are shown after a restart, an import or an archive.
* Good, because any local session can be imported, and a session continued outside dia is caught up on open.
* Good, because archive and unarchive are events, and unarchive restores a resumable agent.
* Bad, because the conversation exists twice: in `agent_events` and in the SDK JSONL. Catch-up on open reconciles the two only when an agent is opened.
* Bad, because the screen and the model can disagree between a turn added outside dia and the next open of that agent.
* Bad, because every streaming agent commits about 20 transactions per second on the Host's event loop. 200 single-event `AgentEventStore.append` commits took 21–29 ms at `synchronous = NORMAL` (0.10–0.14 ms each) and 250–265 ms at `FULL` (1.25–1.33 ms each), measured three times on an NVMe SSD (#152), so one streaming agent costs about 3 ms of event-loop time per second.
* Bad, because `host.db` grows with every conversation. Archive compaction removes only superseded streaming rows.
* Bad, because the import and catch-up rely on the JSONL entry format, which the Agent SDK documents as CLI-internal (`SessionStoreEntry` in `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` 0.3.311).

## Pros and Cons of the Options

### Conversation events in `host.db`; the SDK JSONL is used only for `resume`

* Good, because history loads, imports, archive and replay all read and write one indexed store.
* Bad, because dia owns a second copy of the conversation and the code that keeps it in step with the JSONL.

### Persist only the live `EventHub` stream; the SDK JSONL stays the transcript dia renders

* Good, because ADR-0011 stands and the change is limited to `EventHub`.
* Bad, because every history load still parses the JSONL and drops tool calls.
* Bad, because an imported session still has no events, so import fidelity is unchanged.

### Persist only lifecycle events (imported, archived, unarchived, session bound)

* Good, because it is the smallest store.
* Bad, because it changes neither history load time nor history content.

## More Information

* Supersedes ADR-0011. Amends ADR-0022: the `EventHub` replay buffer is replaced by `agent_events` cursors. ADR-0022 named a second client, work with no window open, and a non-Claude provider as reasons to add a durable event store. This ADR adds it for import, history load time and archive instead.
* Amends ADR-0050: `PaneChatProjection` is seeded from `agent_items` instead of the text-only transcript, so turns from before the Host started keep their tool calls.
* Amends ADR-0042: `host.db` uses `synchronous = NORMAL` instead of the `FULL` default that ADR-0042 measured.
* Amends `docs/designs/archive-delete-agents.md`, which has no unarchive.
* Reference implementation: T3 Code (`F:\Dev\dia\.repos\t3code`, `apps/server/src`). `persistence/Sqlite.ts` (pragmas), `orchestration-v2/EventSink.ts` (event and projection in one transaction), `orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts` (50 ms coalescing), `project/AgentSessionImporter.ts` (Claude session import), `orchestration-v2/ProjectionMaintenance.ts` (compaction).
* Agent SDK references: `resume`, `listSessions` and `getSessionMessages` in `sdk.d.ts`; moving a session file between hosts in [code.claude.com/docs/en/agent-sdk/sessions](https://code.claude.com/docs/en/agent-sdk/sessions).

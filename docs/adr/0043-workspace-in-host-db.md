---
status: "accepted"
date: 2026-10-31
decision-makers: William Pei
---

# Store the workspace in `host.db` as relational tables, with every session of each agent

## Context and Problem Statement

ADR-0042 kept `workspace.json` as JSON: one writer, the whole project and tab tree written atomically. Three needs changed that verdict:

* `Tab.sessionId` holds one session. `/clear` and a rewind each start a new session, so the earlier ones are forgotten, and the org's retro (ADR-0035, `docs/prds/org.md` user story 14) cannot find every session of a task.
* #69's pane runtime tables in `host.db` need an agent row to reference.
* Adding a project will import what the harness already has (#96); dia needs a record of which sessions belong to which agent.

Where and in what shape is the workspace stored?

## Decision Drivers

* Other `host.db` tables must be able to reference an agent, and a save must not delete their rows.
* Every SDK session an agent has had must be recorded.
* `PaneWorkspace`, `Tab` and the renderer should not change.
* An existing `workspace.json` must carry over, and bad data must never stop the Host or be deleted.

## Considered Options

* Relational tables in `host.db`: `projects`, `agents`, `agent_worktrees`, `agent_sessions`, `workspace_state`
* One `host.db` row holding the encoded `Workspace`
* Keep `workspace.json` (ADR-0042)

## Decision Outcome

Chosen option: "Relational tables in `host.db`", because it is the only option other tables can reference with a foreign key, and it records every session of an agent. The design is `docs/designs/workspace-store.md`.

* An agent is ADR-0023's tab; its `agent_id` is the tab's pane id. SQL uses the domain names; TypeScript keeps `Tab` and `paneId`.
* `agent_sessions` holds every session of an agent; the row with `superseded_at IS NULL` is `Tab.sessionId`.
* A hired agent (ADR-0033) has no row here. It runs a task in an `agents` row; the org plugin links a task to an `agent_id` in its own `data.db`.
* `WorkspaceStore.save` writes the difference from the stored rows in one transaction and never rewrites an unchanged row.
* Building the store imports `workspace.json` once and renames it to `workspace.imported.json`.
* Rows that do not decode are left out of the loaded workspace and kept unchanged; #97 shows them to the user.

This supersedes ADR-0042's "`workspace.json` stays JSON" row. The rest of ADR-0042 stands.

### Consequences

* Good, because #69 and later per-agent tables reference `agents (agent_id)` and keep their rows across saves.
* Good, because #14, #42 and #96 can read every session of an agent.
* Good, because `PaneWorkspace` keeps saving the whole `Workspace`; no operation changes.
* Bad, because each save reads the stored ids and compares them, instead of writing one file.
* Bad, because a new `PaneConfig` field needs a migration that adds a column.
* Bad, because a removed agent's earlier transcripts stay on disk until #14 or #95 settles who deletes them.

## Pros and Cons of the Options

### One `host.db` row holding the encoded `Workspace`

* Good, because it is the smallest change.
* Bad, because no other table can reference an agent.
* Bad, because it adds only transactions over today's atomic file write.

### Keep `workspace.json`

* Good, because nothing changes.
* Bad, because session history and references from `host.db` tables are impossible.

## More Information

* Issue #94. Related: ADR-0023, ADR-0033, ADR-0042, #14, #42, #69, #95, #96, #97.

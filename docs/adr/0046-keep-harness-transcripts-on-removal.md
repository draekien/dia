---
status: "accepted"
date: 2026-10-31
decision-makers: William Pei
---

# Keep the agent harness's transcripts when dia removes a project or an agent

## Context and Problem Statement

ADR-0023's Delete row says deleting an agent "Removes the tab's worktree and its session transcripts", and Remove Project followed that rule: it called `AgentBackend.deleteSession` for each tab's current session. Transcripts are files the agent harness writes and owns (Claude Code keeps them under `~/.claude/projects/` and deletes old ones after `cleanupPeriodDays`). Adding a project imports its agents from what the harness still holds (#96), so a transcript dia deletes cannot be imported when the project is added again.

```text
before                                    after
Remove project → deleteSession(bbbb)      Remove project → dia forgets its rows and worktrees only
Add project    → nothing to import        Add project    → #96 imports aaaa, bbbb as agents
```

Does dia delete a harness transcript when it removes a project or an agent?

## Decision Drivers

* Re-adding a project must find every session the harness still holds (#96).
* dia deletes only what dia created: its `host.db` rows and the worktrees it added.
* A transcript deleted while the agent's `claude` process exits is written again as a stub (`docs/reasoning/2026-10-31-agent-sessions-clear-and-removal-race.md`).

## Considered Options

* Keep transcripts; the harness's own cleanup removes them
* Delete each agent's current transcript (ADR-0023, the behaviour before this ADR)

## Decision Outcome

Chosen option: "Keep transcripts", because a transcript belongs to the harness and re-adding a project depends on it.

* Remove Project stops each agent, deletes the worktree dia created for it, and deletes the project's `host.db` rows. The Remove Project dialog lists agents and worktrees only.
* Deleting one agent (#14) removes its worktree and its `host.db` rows, and keeps its transcripts. This replaces the Delete row of ADR-0023's table.
* `AgentBackend` has no method that deletes a transcript, and `RemovalItem` has no transcript item.

### Consequences

* Good, because re-adding a project can import every session the harness still holds.
* Good, because removal no longer races the exiting `claude` process over the transcript file.
* Bad, because transcripts of removed projects use disk space until the harness's cleanup deletes them.

## Pros and Cons of the Options

### Keep transcripts

* Good, because dia deletes nothing it did not create.
* Bad, because a user who wants a transcript gone deletes it through the harness or by hand.

### Delete each agent's current transcript

* Good, because removal frees the transcript's disk space at once.
* Bad, because it deleted only the current session; earlier sessions of the agent stayed on disk.
* Bad, because a re-added project could not import the deleted sessions.

## More Information

Amends ADR-0023 (the Delete row of its table). Issues #95 (this change), #96 (import on add) and #14 (delete one agent).

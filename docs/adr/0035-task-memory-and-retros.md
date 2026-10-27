---
status: "accepted"
date: 2026-10-28
decision-makers: William Pei
---

# Give each task a scratchpad and a transcript record, require a retro before a task completes, and let the retro write scoped long-term memory

## Context and Problem Statement

Hired agents work on tasks across many projects (ADR-0033). What one agent learns, for example "in dia, `pnpm typecheck` exits 1 on Effect warnings", is lost when its session ends, and the next agent repeats the mistake. dia needs short-term memory for sessions working on the same task, long-term memory for later agents, a way to decide what enters long-term memory, and a way to find entries that are no longer used.

## Decision Drivers

* Long-term memory must be shared, not owned by one hired agent (ADR-0033).
* What enters memory must come from evidence: the transcripts of the work.
* Reviewing every memory entry before it applies would make the user a bottleneck.
* Stale entries cost input tokens in every session that loads them.

## Considered Options

* Short-term memory: a scratchpad per objective; a scratchpad per task; the session's own context only
* Long-term writes: agents write and the user reviews in batches; agents propose and the user approves first; agents write freely; a retro agent writes from the task's transcripts

## Decision Outcome

Chosen options: "a scratchpad per task" and "a retro agent writes from the task's transcripts", because sessions on one task share findings at once, and long-term memory is written from a complete record of the task by one agent whose job is to write it.

### Task record

* Every session that works on a task saves its transcript against that task.
* Each task has a scratchpad. Sessions on the task read and write it with `scratchpad_read` and `scratchpad_write`. Sessions on other tasks do not see it.

### Retro

A task cannot move to `completed` until a retro has run. The retro is a session of the `retro` role. It reads every transcript saved against the task and the task's scratchpad, and writes long-term memory with `memory_write`. A write applies at once or waits in the decision queue according to the tier the user sets for long-term memory (ADR-0036); the default applies it at once. The retro also cites the memory entries the task's sessions acted on, and can call `propose_change` (ADR-0036).

### Long-term memory

| Scope | Loaded into | Example entry |
| --- | --- | --- |
| Project | Agents working in that project | "dia uses Effect v4; read `node_modules/effect/AGENTS.md` first" |
| Environment | Every agent on this machine | "The Bash tool is Git Bash; Python is Windows Python" |
| Role | Agents of that role | "engineer: check the exit code of `pnpm typecheck`" |

* dia records each citation of an entry by a retro: the count, the last citation time and the cited task. Loading an entry into a session and returning it from `memory_search` are not citations. An entry not cited for a configurable period is marked stale.
* The user can browse memory, edit it by hand, or ask a meta agent to edit it. A routine can run a meta agent to merge duplicates and remove stale entries.

### Consequences

* Good, because every completed task leaves memory behind for the next agent.
* Good, because read telemetry shows which entries are used.
* Bad, because under the default tier a wrong entry written by a retro reaches agents in its scope before anyone reviews it; the change log makes it revertible (ADR-0036).
* Bad, because staleness depends on the retro citing every entry a task used; an entry the retro misses looks unused.
* Bad, because every task runs one more session, which costs tokens and counts toward the caps.

## Pros and Cons of the Options

### Short-term memory: a scratchpad per objective

* Good, because every agent on the objective sees every finding.
* Bad, because notes from unrelated tasks fill each agent's context.

### Short-term memory: the session's own context only

* Good, because there is nothing to build.
* Bad, because a resumed session or a reviewer starts without the earlier session's findings.

### Long-term writes: agents write, the user reviews in batches

* Good, because agents learn at once.
* Bad, because every agent writes, so entries duplicate and conflict.

### Long-term writes: agents propose, the user approves first

* Good, because nothing applies unreviewed.
* Bad, because the user becomes the bottleneck for every entry.

### Long-term writes: agents write freely

* Good, because it is the simplest.
* Bad, because entries are written mid-task, before the agent knows whether its approach worked.

## More Information

* Related: ADR-0025 (meta project), ADR-0033 (org), ADR-0036 (self-improvement), `docs/prds/org.md`.
* Open: whether long-term memory is stored in the meta repo or under `userData`, and the staleness period (`docs/prds/org.md`, Open Questions).

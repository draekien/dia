---
status: "accepted"
date: 2026-11-15
decision-makers: William Pei
---

# Threads are runs the user starts; agents are org issue runs, listed in their own sidebar section

## Context and Problem Statement

The sidebar called every run an "agent". The org (ADR-0080) also opens a tab for each issue run of a hired agent (#282), so the user's own chats and the org's autonomous runs were mixed in the same project groups. The Executive assistant was a tab in a registered `assistant` project. Notices for the assistant reached it only when the user next asked it something. How should dia tell runs the user drives apart from runs the org drives, and how should the assistant learn about org events without waiting for the user?

## Decision Drivers

* The user must see at a glance which runs need their input and which run on their own.
* The kernel hosts chat only in tabs; a page cannot host a transcript.
* A plugin must not need kernel changes to list its own runs.
* Stored workspaces from before this change must decode unchanged.

## Considered Options

* Tab owner marker, a sidebar sections slot and a page that names a tab
* A separate run list fed by the org, with no tabs for issue runs
* Keep one list and tag org rows

## Decision Outcome

Chosen option: "Tab owner marker, a sidebar sections slot and a page that names a tab", because it keeps every run in a tab (so chat, queue and steer work unchanged) and lets `dia-org` list its runs without the thread list knowing about the org.

Vocabulary: a **thread** is a run the user starts and drives; an **agent** is an org hire, shown as one sidebar row per issue run; the **Assistant** is the Executive assistant's one persistent run; a **routine** is a run a schedule starts. Code uses **run** for all of them (`RunSummary`, `RunSummaryStatus`). The `dia-agent-overview` plugin is renamed `dia-threads`.

* `Tab.owner` and `Project.owner` (optional plugin name) mark a tab or project a plugin lists itself. `TabPlacement` gains `owner: TabOwner { plugin, ownsProject }` and `name`. `WorkspaceOps.claimTab` sets them on a tab that already exists. The thread list leaves out owned tabs and owned projects.
* `dia-layout` gains `SidebarSectionsSlot`, a list of `SidebarSection { id, order, component }` drawn between the pages and the thread list. `dia-org` fills it with the Agents section: one row per started issue run that has a tab, most urgent status first.
* `Page.tab` is an optional atom naming the tab a page entry stands for. While it names a tab, clicking the entry selects that tab and the entry shows the tab's status. The org's Assistant page uses it for the assistant's run.
* A user message whose text starts with `NOTICE_MARKER` (`src/shared/domain/pane-chat.ts`) is shown as a notice, not as the user's message. `dia-org`'s assistant sends pending notices with that marker as soon as its run is live, not busy and has no open request.

### Consequences

* Good, because threads and agents are visually separate, and a needs-input agent sorts to the top of its section.
* Good, because the assistant learns about org events without a user message.
* Bad, because the tab owner is a plugin name string; renaming `dia-org` needs a stored-data migration for owned tabs and projects.
* Bad, because a notice sent in the same instant as a user message shows its raw marker in the composer's queue chip.

## Pros and Cons of the Options

### Tab owner marker, a sidebar sections slot and a page that names a tab

* Good, because issue runs keep their tabs, transcripts and composers.
* Bad, because two optional fields are added to the kernel workspace schema.

### A separate run list fed by the org, with no tabs for issue runs

* Good, because the workspace schema does not change.
* Bad, because selecting a row still needs a tab to show the chat, so the tab problem returns (rejected in `docs/designs/dia-org.md` D12).

### Keep one list and tag org rows

* Good, because it is the smallest change.
* Bad, because org runs still interleave with the user's threads in every project group.

## More Information

Design: `docs/designs/threads-and-agents.md`. Supersedes `docs/designs/dia-org.md` D12's listing of issue runs under their project. Builds on ADR-0061 (pages slot), ADR-0071 (Executive assistant) and ADR-0080.

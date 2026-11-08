---
status: "accepted"
date: 2026-11-08
decision-makers: William Pei
---

# Plugins attach the sessions they open to the Host, which shows each as a row in its project

## Context and Problem Statement

ADR-0067 has the org plugin open each hired agent's session itself, with no tab, so the user cannot see the transcript, answer a permission request in a pane, or `steer` the agent (PRD `docs/prds/org.md`, goal 11). How does a session a plugin owns reach the agent overview and a chat pane, and where in the overview does it appear?

## Decision Drivers

* The org dispatcher must keep owning the session's lifetime and every event that frees or takes a slot (ADR-0033, ADR-0067).
* Tab counts and the ad-hoc tab rules must not include org work (ADR-0033).
* The transcript, `queue`/`steer` composer and permission cards already exist for tabs; a hired agent's session should use them, not a copy.
* A shipped plugin imports host values only from `@dia/plugin`.

## Considered Options

* Placement: a row in the issue's project group, labelled with the hire's name.
* Placement: a separate "Org" group in the overview.
* Transport: a Host attach API, `HostPluginContext.sessions.attach`, that runs the plugin's session through the Host's pane machinery.
* Transport: the org plugin exposes transcript and send calls over its own plugin RPC, and a renderer view calls them.

## Decision Outcome

Chosen options: "a row in the issue's project group" and "a Host attach API", because the user finds an agent by project already, and the Host attach API gives a hired agent's session the same recorder, chat projection, summary, composer and permission cards as a tab without a second copy of them.

`ctx.sessions.attach({ display, resume, open })` is scoped. While the scope is open the Host records the session's events, publishes its pane signals, routes pane RPCs to it, and lists `display` in `GetAttachedSessions` and `AttachedSessionsChanged`. Closing the scope removes the row. An attached session is never a `Workspace` tab and is never saved.

This amends ADR-0067: a hired agent's permission request is now shown in its pane. The org dispatcher wraps the session it attaches so an answer from the pane goes through `answerPermission`, keeping ADR-0033's slot rules in the dispatcher.

### Consequences

* Good, because transcript, composer `queue`/`steer`, permission cards and status summaries are the tab code paths, not copies.
* Good, because `Workspace`, tab counts and the workspace store are unchanged.
* Bad, because the Host's plugin context gains a host-only member (`sessions`), so `HostPluginContext` in `src/host/plugins/host-plugin-context.ts` widens the shared context.
* Bad, because `HostPlugins` and the services `attach` uses depend on each other; `SessionAttacher`, a `Deferred` that `AttachedSessionsLive` completes, breaks that cycle.
* Bad, because the model, thinking and permission pickers, rewind, rename, archive and delete are hidden for an attached session: the plugin, not the user, owns its settings and lifetime.

## Pros and Cons of the Options

### A row in the issue's project group

* Good, because a hired agent working in a project is listed with the other agents in that project.
* Bad, because a row that is not a tab needs a caption (the job title) and a reduced row menu to tell it apart.

### A separate "Org" group

* Good, because org work is visually separate from ad-hoc tabs.
* Bad, because the user looks in two places for agents working in one project.

### A Host attach API

* Good, because every pane feature reaches the attached session through `PaneSupervisor.attachPane`.
* Bad, because the Host plugin context grows a host-only API.

### Plugin RPC with its own view

* Good, because no kernel change is needed.
* Bad, because the org plugin would reimplement recording, chat projection, summaries and the composer.

## More Information

Design: `docs/designs/attached-sessions.md`. Issue: #182. Visual rules: `DESIGN.md` (Agent Overview, Row).

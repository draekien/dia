---
status: accepted
date: 2026-11-17
decision-makers: William Pei
---

# `dia-tools` lets a tool handler ask the user to approve a call, in dia's window, whatever the session's permission mode

## Context and Problem Statement

A dia tool call reaches the user only through the session's `canUseTool` prompt (`plugins/dia-claude-code/session.ts`). The Agent SDK does not call `canUseTool` for an MCP tool under `bypassPermissions`, when an allow rule matches, or in `dontAsk` (`docs/reasoning/2026-10-24-phase-3-research-findings.md`). Some tool calls must always wait for the user, for example a change to the Executive assistant job title or to a job title's permission rules (#293). How does a tool handler get the user's approval for one call?

## Decision Drivers

* The approval is asked for in every permission mode, and for agents outside dia.
* A tool decides per call whether it needs approval, from the call's input.
* A request never outlives the token or the `dia-tools` instance it was made under.

## Considered Options

* `Tools.requestApproval(scope, request)`, shown in a dialog in dia's window
* The session's `canUseTool` prompt, with the tool kept off every allow list
* MCP elicitation (`elicitation/create`) sent to the agent's client

## Decision Outcome

Chosen option: "`Tools.requestApproval(scope, request)`, shown in a dialog in dia's window", because it is the only option that dia controls in every permission mode and for every client.

* `Tools` (ADR-0075) gains `requestApproval(scope, { title, before, after })`, which succeeds with `'approved'` or `'declined'`. The handler passes the `ToolScope` it received.
* The request ends as `'declined'` when the token it was made under is revoked or when `dia-tools` closes. A request under a revoked token, or after `dia-tools` closed, returns `'declined'` at once. Interrupting the call (MCP cancellation, or its server closing) withdraws it. There is no timeout.
* A request belongs to the token whose granted scope object the handler received; the registry stores a copy of the scope per token, so no two tokens share one.
* `dia-tools` serves the pending requests as a stream and takes answers by request id. Its renderer entry shows the oldest pending request in one dialog that closes only on an answer.

Design: `docs/designs/tool-call-approval.md`. Amends ADR-0075.

### Consequences

* Good, because any plugin's tool can require approval for the calls it judges risky.
* Good, because the answer does not depend on how the session was configured.
* Bad, because a pending request blocks its tool call until the user answers, with no timeout.
* Bad, because the dialog is modal: the user answers before using the window again.

## Pros and Cons of the Options

### The session's `canUseTool` prompt, with the tool kept off every allow list

* Good, because it needs no new UI.
* Bad, because `bypassPermissions` and `dontAsk` skip it, and an outside agent's client decides whether to prompt.

### MCP elicitation (`elicitation/create`) sent to the agent's client

* Good, because it is part of the MCP protocol.
* Bad, because the client decides whether and how to show it; which clients show it is unverified.

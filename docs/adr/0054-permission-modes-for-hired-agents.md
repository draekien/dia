---
status: "accepted"
date: 2026-11-06
decision-makers: William Pei
---

# Run hired agents in `auto` where the model and settings allow it, otherwise in `default`, and in `bypassPermissions` only when the user opts a role or hire in

## Context and Problem Statement

Hired agents (ADR-0033) run without the user watching them. In `default` mode every tool call that needs approval stops the agent until the user answers, which the user wants to avoid. `bypassPermissions` removes those stops and every check with them; dsh-superagent's executors run that way ("Executor Sessions run commands without approval", its `docs/003-execution.md`). The user wants `auto`, where a model classifier approves or denies, wherever it is available, and wants `bypassPermissions` used as little as possible. Which permission mode does each hired agent session and each router session (ADR-0053) start in?

## Decision Drivers

* A hired agent should not stop for approval when a classifier can decide.
* `bypassPermissions` runs only because the user chose it.
* A role's allow/ask/deny list (ADR-0033) must keep its meaning in every mode.
* Ad-hoc tabs keep their current behaviour: the user picks the mode.

## Considered Options

* When `auto` is unavailable: `default`, with prompts in the decision queue; `dontAsk`; refuse to start the agent
* `bypassPermissions`: an explicit opt-in used only when `auto` is unavailable; the automatic fallback when `auto` is unavailable; an opt-in that overrides `auto`

## Decision Outcome

Chosen options: "`default`, with prompts in the decision queue" and "an explicit opt-in used only when `auto` is unavailable", because the agent uses the classifier wherever it exists, and no session runs without checks unless the user chose it.

### Mode at session start

Evaluated once, when the Host starts a hired agent session, in this order; the first row that matches wins.

| Condition | Mode |
| --- | --- |
| The model's `ModelOption.autoMode` is `true` and `disabledPermissionModes` for the session's `cwd` does not contain `auto` (`plugins/claude-code/permission-settings.ts`) | `auto` |
| The role or the hire opts into bypass, and `disabledPermissionModes` does not contain `bypassPermissions` | `bypassPermissions` |
| Otherwise | `default` |

* The bypass opt-in is a role setting, off by default. A hire can override its role's setting. The settings screen hides the opt-in when `disabledPermissionModes` contains `bypassPermissions`.
* A router session (ADR-0053) always starts in `dontAsk`: its role allows only the routing tools and every other tool is denied without a prompt.
* Ad-hoc tabs are unchanged.
* In `default`, every call that needs approval reaches `canUseTool`, which puts an `ask` item in the decision queue (ADR-0034); the agent's slot is freed while it waits (ADR-0033).

### A role's allow/ask/deny list in each mode

From the Agent SDK permissions page (<https://code.claude.com/docs/en/agent-sdk/permissions.md>) and the permission modes page (<https://code.claude.com/docs/en/permission-modes.md>), read 2026-11-06.

| Entry | `default` | `auto` | `bypassPermissions` |
| --- | --- | --- | --- |
| `deny` | Blocks | Blocks | Blocks ("Deny rules block in every mode, including `bypassPermissions`") |
| `ask` | `canUseTool`, so a decision queue item | `canUseTool`, so a decision queue item ("Explicit ask rules still force a prompt"; confirmed by probe, `docs/reasoning/2026-11-06-auto-mode-ask-rules-and-classifier-blocks.md`) | `canUseTool`, so a decision queue item ("falls through to your `canUseTool` callback … even in `bypassPermissions` mode") |
| `allow` | Approves | Approves, except broad rules, which `auto` drops: `Bash(*)`, wildcarded interpreters such as `Bash(python*)`, package-manager run commands, `Agent`, `Monitor` | No effect |

When the `auto` classifier blocks a call, the agent receives the reason and continues; no decision queue item is created. The SDK types list the auto-mode classifier among the calls "auto-denied without an interactive permission prompt" (`sdk.d.ts`, SDK 0.3.311). Four probes on 2026-11-06 produced no classifier block to observe, so dia must not depend on `canUseTool` being called, or not called, for a block (`docs/reasoning/2026-11-06-auto-mode-ask-rules-and-classifier-blocks.md`).

### Model change during a session

When a hired agent's session switches to a model without `auto`, the SDK drops the session to `default` (permission modes page). dia does not then switch it to `bypassPermissions`; prompts go to the decision queue.

### Consequences

* Good, because on a model with `auto`, a hired agent stops only for `ask` entries and its own recorded decisions.
* Good, because `bypassPermissions` never starts unless the user turned it on for that role or hire.
* Good, because `deny` entries hold in every mode.
* Bad, because on a model without `auto`, and without the opt-in, the decision queue can fill with permission prompts.
* Bad, because `auto` drops broad `allow` entries, so a role written with `Bash(*)` behaves differently in `auto` than in `default`.

## Pros and Cons of the Options

### When `auto` is unavailable: `dontAsk`

* Good, because the agent never waits on the user.
* Bad, because every call the role's allow list misses fails, so agents report `blocked` unless allow lists are complete.

### When `auto` is unavailable: refuse to start

* Good, because every hired agent runs with the classifier.
* Bad, because a user on a model or plan without `auto` cannot use the org.

### `bypassPermissions` as the automatic fallback

* Good, because hired agents never stop for approval, as in dsh-superagent.
* Bad, because a model without `auto` runs every tool without checks, without the user choosing that.

### `bypassPermissions` as an opt-in that overrides `auto`

* Good, because the user can remove classifier blocks for a role they trust.
* Bad, because it removes the classifier where it exists, which the user asked to avoid.

## More Information

* Related: ADR-0033 (roles and their permission lists), ADR-0034 (decision queue), ADR-0053 (router), `docs/prds/org.md`, `docs/plans/2026-10-28-org.md` step 1.
* `auto` model support (permission modes page): on the Anthropic API, Claude Opus 4.6 or later, Sonnet 4.6 or later, Haiku 5.5, or a Fable model. dia reads support from `ModelOption.autoMode` rather than from this list.

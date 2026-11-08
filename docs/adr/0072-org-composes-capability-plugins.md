---
status: "accepted"
date: 2026-11-08
decision-makers: William Pei
---

# Split the org plugin into capability plugins that own registries, and make the org compose them

## Context and Problem Statement

`plugins/org` holds job titles and their MCP servers and skill names (ADR-0064), hired agents, objectives and issues (ADR-0069), the dispatcher, and the Executive assistant session (ADR-0071). Issues #41–#46 of epic #39 would add the decision queue, memory and retros, `propose_change`, workflows, routines and KPIs to the same plugin. A job title's MCP servers are copied into each job title's row, and nothing outside the org can use a job title, an MCP server definition or an issue. Which parts become their own plugins, how do they refer to each other, and which way do their dependencies point?

## Decision Drivers

* ADR-0019 makes every feature a plugin.
* `deepseek-harness` (`.repos/deepseek-harness`, built on `cordis`) splits the same capabilities into plugins. A capability plugin provides a registry service with `register*()` methods, contributor plugins inject that service and register entries, and an entry is removed when its contributor unloads (`packages/skill/skill/src/index.ts:390-460`, `packages/mcp/mcp-manager/src/index.ts:285-304`). Higher-level plugins inject lower-level services; lower-level services never register into higher-level ones.
* dia's kernel already removes a contribution when its contributor unloads: `whenProvided` runs its setup in a child scope that is closed before the contributor or the provider closes, and runs it again when every key is provided again (`src/shared/plugin/api.ts:76-87`). A `register` that returns `Effect<void, never, Scope.Scope>` built on `Effect.acquireRelease` therefore needs no kernel change.
* The Agent SDK loads skills only as `SKILL.md` files on disk, from `settingSources` directories or a local SDK plugin path; `Options.skills` filters discovered skills by name (https://code.claude.com/docs/en/agent-sdk/skills.md, https://code.claude.com/docs/en/agent-sdk/plugins.md). The meta repo (ADR-0025) already holds dia's own skills in `meta/plugin/skills/`.
* "Agent" already names a tab in a project (ADR-0023).

## Considered Options

* What a capability plugin owns: a registry service that other plugins contribute to, with user-created items as one contributor; a library with its own storage only; exported code only, with the org storing all data
* Hired agents: stay in the org; an `agents` plugin
* An issue's assignee: an opaque reference that assignee providers register; the org's `HireId`
* A definition that refers to an MCP server or skill that no longer exists: refuse to start the session; start without it; block the delete
* What a routine runs: an action from an action registry; always an issue
* Order: extract first, then #41–#46; build #41–#46 against the current org and extract afterwards

## Decision Outcome

Chosen options: "a registry service that other plugins contribute to", "stay in the org", "an opaque reference that assignee providers register", "refuse to start the session", "an action from an action registry" and "extract first", because they follow the `deepseek-harness` plugin model on kernel APIs dia already has, keep every dependency pointing from a composing plugin to a capability plugin, and let a capability be used outside the org.

### Plugins and their dependencies

An arrow points from the plugin that injects to the plugin it injects.

```text
assistant ──► org ──► issues
assistant ──► agent-definitions
org ──► agent-definitions ──► skills
                          └──► mcp
meta ──► skills, routines          (contributes skill sources and the run-meta-agent action)
claude-code ──► skills             (contributes Claude Code's skill directories)
issues ──► routines                (contributes the create-issue action)
memory ──► issues                  (creates retro issues, ADR-0035)
decision-queue, memory, propose-change, workflows, kpis   (#41–#46, one plugin each)
```

| Plugin | Registry it provides | Contributors | Storage it owns |
| --- | --- | --- | --- |
| `skills` | skill sources | `meta` (`meta/plugin/skills`), `claude-code` | none. dia writes skill files only in the meta repo |
| `mcp` | MCP servers by name | the user's servers; any plugin that ships a server | the user's servers |
| `agent-definitions` | agent definitions by id | the user's definitions; `org` (the seven built-in job titles); `assistant` (Executive assistant) | the user's definitions |
| `issues` | objectives, issues, comments, issue tools; assignee providers | `org` registers its hired agents as assignees | objectives, issues, comments |
| `routines` | schedules; action kinds | `issues` (`create-issue`), `meta` (`run-meta-agent`) | schedules |
| `org` | hired agents, the org chart, the dispatcher and the overall cap | none | hired agents |
| `assistant` | the Executive assistant session and its routing tools | none | the session id |

### Contribution contract

A registry's `register` returns `Effect<void, never, Scope.Scope>`. A contributor calls it inside `whenProvided([RegistryKey], …)`, so the entry is removed when the contributor or the registry closes, and registered again when both are open.

### References

* An agent definition holds `skills` and `mcpServers` as names, not copies. A skill name is the name `Options.skills` takes, for example `dia-meta:code-review`.
* An issue's assignee is `{ provider: string, id: string } | null`. `issues` imports nothing from `org`. The org's dispatcher watches issue changes and starts the issues assigned to its hired agents.
* `org` creates an objective's planning issue (ADR-0069) through `issues`. `memory` creates retro issues (ADR-0035) through `issues`. `issues` has no rule that creates an issue by itself.

### Missing references

* A session for a definition whose MCP server or skill name resolves to nothing does not start. Its issue moves to `triage`, and the reason names each missing item.
* The UI shows the missing item as `<name> (missing)` on the definition.
* An issue whose assignee provider is not loaded keeps its assignee and is not started.
* A routine whose action provider is not loaded skips the run and shows the action as missing.

### Names

* The `agent-definitions` plugin and the Settings page say "agent definition".
* The org's UI says "job title" for the agent definition a hired agent is hired as (ADR-0064).
* `docs/glossary.md` defines both terms and states that a job title is an agent definition.

### Migration

The extraction moves data out of `org.db` without loss. Each job title becomes an agent definition with the same id. Each job title's inline `mcpServers` entries become named servers in `mcp`. Two entries with the same name and different configs keep the first name and give later ones a numeric suffix (`github`, `github-2`), and the definitions are rewritten to the new names.

### Order

1. `mcp` registry and `skills` registry.
2. `agent-definitions`, with the `org.db` job title migration.
3. `issues`, with the assignee provider contract and the `org.db` objective and issue migration.
4. `assistant`.
5. #41–#46, each as its own plugin.

### Consequences

* Good, because an agent definition, an MCP server or an issue can be used without the org, for example in an ad-hoc tab.
* Good, because a change to an MCP server reaches every definition that names it.
* Good, because #41–#46 are written once, against the extracted services.
* Good, because the kernel needs no new API.
* Bad, because a definition can name an item that no longer exists, and a session for it refuses to start until the user fixes the definition.
* Bad, because the extraction delays #41–#46.
* Bad, because one record has two names: agent definition and job title.

## Pros and Cons of the Options

### What a capability plugin owns

* A registry service with contributors. Good, because other plugins add entries without the owner knowing them, as in `deepseek-harness`. Bad, because each registry needs a contribution contract.
* A library with its own storage only. Good, because each item has one owner. Bad, because skills cannot be stored this way without a second skill store next to the meta repo, and other plugins cannot add entries.
* Exported code only. Good, because it moves files and no data. Bad, because the org stays the only user of the data.

### Hired agents

* Stay in the org. Good, because a hired agent's name, `reportsTo` and issue assignment only have meaning in the org, and no second meaning of "agent" is added beside the project tab (ADR-0023). Bad, because a named agent cannot be used outside the org.
* An `agents` plugin. Good, because a named agent could open an ad-hoc tab. Bad, because "agent" would name two different things.

### An issue's assignee

* An opaque reference. Good, because `issues` does not depend on `org`. Bad, because the planning issue and retro issue rules move out of `issues` into `org` and `memory`.
* The org's `HireId`. Good, because it is the current schema. Bad, because `issues` and `org` would depend on each other.

### A missing reference

* Refuse to start. Good, because a hired agent never runs without the tools its definition lists. Bad, because the issue waits until the user fixes the definition.
* Start without it. Good, because work continues. Bad, because the agent may do the work wrongly without reporting it.
* Block the delete. Good, because a referenced item cannot be deleted. Bad, because a contributor's unload cannot be blocked, so a second rule is still needed.

### What a routine runs

* An action registry. Good, because the meta agent's memory cleanup (PRD story 19) runs without an issue, and `routines` depends on nothing. Bad, because each action kind needs a provider.
* Always an issue. Good, because there is one routine shape. Bad, because `routines` depends on `issues`, and every routine needs an objective and an assignee.

### Order

* Extract first. Good, because #41–#46 are not rewritten. Bad, because no user-visible feature ships during the extraction.
* Build first, extract later. Good, because #45 ships sooner. Bad, because #42 and #45 would be written against `plugins/org/work.ts` and rewritten.

## More Information

* Amends ADR-0064 (job titles are agent definitions in the `agent-definitions` plugin), ADR-0069 (objectives and issues move to the `issues` plugin) and ADR-0071 (the Executive assistant session moves to the `assistant` plugin).
* Epic: https://github.com/draekien/dia/issues/39. The steps in "Order" are #220 (`mcp`), #221 (`skills`), #222 (`agent-definitions`), #223 (`issues`) and #224 (`assistant`); #41–#46 follow.
* Reference: `.repos/deepseek-harness/packages/{skill,mcp,preset,schedule}` and `.repos/cordis/packages/core/src/{fiber,service,reflect}.ts`.

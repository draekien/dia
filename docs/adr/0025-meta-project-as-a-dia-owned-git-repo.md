---
status: "accepted, amended by ADR-0035"
date: 2026-10-23
decision-makers: William Pei
---

# Run a meta project: a dia-owned git repo loaded into every agent, changed through approved proposals

## Context and Problem Statement

`PRODUCT.md` defines a meta project whose goal is to reduce waste in every agent the user runs in dia: no-op tool calls, tool calls that return errors, and expensive tool calls. An agent started in the meta project works across all registered projects (ADR-0023), and agents in projects submit improvements to it. What does the meta project change, how do its changes reach every agent, and who approves them?

## Decision Drivers

* A change to the meta project affects every agent, so a wrong change must be reviewable before it applies and revertible after.
* The meta project must not change Claude Code sessions outside dia.
* Ten agents reporting the same problem should produce one change, not ten.
* The meta repo may be pushed to a remote, so it must never contain a secret.
* The Agent SDK 0.3.207 `query()` options include `plugins` (`SdkPluginConfig[]`, skills, agents, hooks, commands and MCP servers; no CLAUDE.md), `systemPrompt` with `{ type: 'preset', preset: 'claude_code', append }`, `additionalDirectories` and `settingSources` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`; https://code.claude.com/docs/en/agent-sdk/plugins.md, https://code.claude.com/docs/en/agent-sdk/claude-code-features.md).

## Considered Options

* Target: a dia-owned meta repo
* Target: the user's `~/.claude` directly
* Target: a meta repo that also publishes to `~/.claude`
* Loop: proposals, then a meta agent, then the user's approval of each merge
* Loop: proposals, then a meta agent that commits directly
* Loop: project agents edit the meta repo themselves

## Decision Outcome

Chosen options: "a dia-owned meta repo" and "proposals, then a meta agent, then the user's approval of each merge", because the meta repo gives every change a git history the user can review and revert, applies only to agents dia starts, and the meta agent combines duplicate proposals.

### The meta repo

A git repo that dia creates under its `userData` directory on first start:

```text
meta/
  instructions.md      appended to every agent's system prompt
  plugin/              loaded as an SDK plugin into every agent
    .claude-plugin/plugin.json
    skills/
    agents/
    hooks/
    commands/
```

Every agent dia starts receives:

```ts
query({
  prompt,
  options: {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: metaInstructions },
    plugins: [{ type: 'local', path: metaPluginPath }],
  },
})
```

`settingSources` keeps its default (`['user', 'project', 'local']`), so the user's `~/.claude` and each project's own configuration still apply; the meta repo adds to them.

### The improvement loop

| Step | Actor | Action |
| --- | --- | --- |
| 1 | An agent in a project | Calls the dia tool `meta_propose` with what went wrong and a suggested change. dia stores the proposal outside the meta repo |
| 2 | The user | Starts an agent in the meta project |
| 3 | The meta agent | Reads the open proposals and the SDK transcripts of every registered project, looks for no-ops, tool errors and expensive tool calls, and combines its findings into changes on a branch |
| 4 | The user | Approves or rejects each branch. An approved branch is merged, and agents started after the merge receive the change |

`meta_propose` is served by the Host's in-process MCP server, the same mechanism as the `plugin_*` tools in Phase 3 of `docs/plans/2026-10-22-plugin-platform.md`.

### Meta agent access

A meta agent can read and write every registered project and its transcripts, as well as the meta repo. dia passes every registered project's directory as `additionalDirectories`.

A meta agent's change to a project follows the same approval rule as a change to the meta repo:

| Project type | How the meta agent changes it |
| --- | --- |
| Git repo | On a branch in a new worktree of that project. The user approves the merge |
| Not a git repo | Each `Edit` and `Write` outside the meta repo produces a permission prompt, whatever the meta tab's permission mode |

### Publishing

The user may add a remote to the meta repo and push to it. dia scans the commits being pushed for secrets and refuses the push when the scan finds one. The scanner is chosen during implementation.

### Consequences

* Good, because every change that affects all agents is a reviewed, revertible git commit.
* Good, because Claude Code sessions outside dia are unaffected.
* Good, because the meta repo can be shared between machines through a remote.
* Bad, because a meta agent with write access to every project can change a project while another tab is working in it; the worktree-and-approval rule limits this to changes the user merges.
* Bad, because transcripts contain tool output, which can include secrets; a meta agent that copies transcript text into the meta repo relies on the push scan to stop it leaving the machine.
* Bad, because instructions in `instructions.md` are added to every agent's system prompt and cost input tokens on every session, so the meta agent must keep the file short.

## Pros and Cons of the Options

### Target: a dia-owned meta repo

* Good, because it has a git history and is scoped to dia.
* Bad, because improvements do not reach the Claude Code CLI outside dia.

### Target: the user's `~/.claude` directly

* Good, because improvements apply to every Claude Code session.
* Bad, because a wrong change also breaks sessions outside dia, and there is no history unless the user keeps `~/.claude` in git.

### Target: a meta repo that also publishes to `~/.claude`

* Good, because it combines the history of the meta repo with reach outside dia.
* Bad, because it adds a publish step before the loop has been shown to work. It is on the roadmap.

### Loop: proposals, then a meta agent, then the user's approval of each merge

* Good, because duplicate proposals become one change, and nothing applies without approval.
* Bad, because improvements wait for the user to start a meta agent and approve.

### Loop: proposals, then a meta agent that commits directly

* Good, because improvements apply sooner.
* Bad, because a wrong change reaches every agent before anyone reviews it.

### Loop: project agents edit the meta repo themselves

* Good, because there is no separate meta agent.
* Bad, because nothing combines duplicate or conflicting changes.

## More Information

* Related: ADR-0019 (kernel), ADR-0023 (projects), `docs/prds/agent-os.md`.
* Roadmap: scheduled meta agent runs; an approval step that copies parts of the meta repo into `~/.claude`.
* Amended by ADR-0035: the retro calls `propose_change` in place of project agents calling `meta_propose`; only change types in the decision queue tier wait for the user's approval; a routine can start a meta agent.

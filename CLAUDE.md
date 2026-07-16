# dia

dia is a personal desktop application — a self-built alternative to Claude Desktop — that drives the user's local Claude installation via the Anthropic TypeScript Agent SDK.

## Architecture decisions

All significant architecture and tech-stack decisions are recorded as ADRs in `docs/adr/`, written in MADR format. **Before proposing or changing anything architectural (process model, framework, build tooling, styling, repo layout), read the existing ADRs in `docs/adr/` first** — do not contradict an accepted decision without first surfacing the conflict to the user and, if they agree to change course, writing a new ADR (or superseding the old one).

See `docs/adr/README.md` for the index of current decisions.

When a new significant architecture decision is made during a session, write it up as a new ADR using `docs/adr/template.md`, following the numbering convention (`NNNN-short-title.md`), and add it to the index in `docs/adr/README.md`.

## Reasoning log

`docs/reasoning/` captures non-obvious decisions, gotchas, and learnings from past sessions — smaller-grained than an ADR (a tricky bug's root cause, a library quirk, a rejected approach and why) but still worth not rediscovering the hard way. **Check `docs/REASONING.md` (the index) when starting work in an area that feels tricky or has surprised you before.**

When you hit a genuinely non-obvious finding during a session — something that took real effort to figure out, or that would trip up a future session — write it up as a new entry using `docs/reasoning/template.md`, named `YYYY-MM-DD-short-slug.md`, and add it to the index in `docs/REASONING.md`. Don't log routine implementation notes.

You must not let the reasoning log drift from the current state of the project. Out of sync documentation is worse than no documentation at all.

## Reference docs

- `docs/llms/electron-vite.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the electron-vite guide (build tool chosen in ADR-0004). Consult it before making electron-vite config, dev/HMR, build, or packaging changes.
- `docs/llms/agent-sdk.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the Claude Agent SDK docs (the SDK dia uses to drive Claude, per ADR-0003). **This is the first thing to check for ANY Agent SDK question or task** — sessions, permissions, hooks, MCP, subagents, or the TypeScript/Python API — whether you're answering a question, debugging, or writing code. Read it before reaching for general Claude API knowledge, a skill, or a subagent; it covers sessions, permissions, hooks, MCP, subagents, and links the full TypeScript/Python API reference.

## Design Context

Renderer-specific — see `src/renderer/CLAUDE.md`.

## Coding

- Make sure to set up logs for code you write using Effect's logger methods so its easy to trace and debug issues.
- You are not allowed to write inline comments. Code must be self-documenting.
- You must write JSDoc for module exports.

### Mandatory skill invocation

These are BLOCKING REQUIREMENTS, not suggestions. Before writing or editing any code matching a trigger below, invoke the listed skill via the Skill tool FIRST — before any other response, plan, or edit for that task. If a task matches more than one trigger, invoke all matching skills before starting. Do not skip a trigger because the change "looks small" or "is just a one-liner."

| Trigger                                                                                                                   | Required skill                               |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Writing or editing any `.ts`/`.tsx` code that uses Effect (services, layers, schemas, streams, runtimes, or typed errors) | `effect-ts`                                  |
| Creating a new service or module                                                                                          | `engineering-skills:module-design`           |
| Writing or updating any test file                                                                                         | `engineering-skills:with-testing-principles` |

Renderer-specific triggers (UI/UX work, shadcn/ui components) are in `src/renderer/CLAUDE.md`.

If you realize partway through a task that a trigger applies and you skipped the skill, stop, invoke the skill, and reconcile your work against its guidance before continuing.

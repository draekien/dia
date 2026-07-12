# dia

dia is a personal desktop application — a self-built alternative to Claude Desktop — that drives the user's local Claude installation via the Anthropic TypeScript Agent SDK.

## Architecture decisions

All significant architecture and tech-stack decisions are recorded as ADRs in `docs/adr/`, written in MADR format. **Before proposing or changing anything architectural (process model, framework, build tooling, styling, repo layout), read the existing ADRs in `docs/adr/` first** — do not contradict an accepted decision without first surfacing the conflict to the user and, if they agree to change course, writing a new ADR (or superseding the old one).

See `docs/adr/README.md` for the index of current decisions.

When a new significant architecture decision is made during a session, write it up as a new ADR using `docs/adr/template.md`, following the numbering convention (`NNNN-short-title.md`), and add it to the index in `docs/adr/README.md`.

## Reasoning log

`docs/reasoning/` captures non-obvious decisions, gotchas, and learnings from past sessions — smaller-grained than an ADR (a tricky bug's root cause, a library quirk, a rejected approach and why) but still worth not rediscovering the hard way. **Check `docs/REASONING.md` (the index) when starting work in an area that feels tricky or has surprised you before.**

When you hit a genuinely non-obvious finding during a session — something that took real effort to figure out, or that would trip up a future session — write it up as a new entry using `docs/reasoning/template.md`, named `YYYY-MM-DD-short-slug.md`, and add it to the index in `docs/REASONING.md`. Don't log routine implementation notes.

## Reference docs

- `docs/llms/electron-vite.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the electron-vite guide (build tool chosen in ADR-0004). Consult it before making electron-vite config, dev/HMR, build, or packaging changes.
- `docs/llms/agent-sdk.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the Claude Agent SDK docs (the SDK dia uses to drive Claude, per ADR-0003). **This is the first thing to check for ANY Agent SDK question or task** — sessions, permissions, hooks, MCP, subagents, or the TypeScript/Python API — whether you're answering a question, debugging, or writing code. Read it before reaching for general Claude API knowledge, a skill, or a subagent; it covers sessions, permissions, hooks, MCP, subagents, and links the full TypeScript/Python API reference.

## Design Context

`PRODUCT.md` and `DESIGN.md` at the repo root carry dia's design system — read before any UI/UX work. Register: **product** (design serves the tool, a single-user pane workspace). North star: **"The Control Room"** — calm, glanceable status across up to six concurrent panes, with amber/red/green pulse indicators as the app's one deliberate loud signal. Key principles: glanceability over detail, one voice for attention (pulse only), calm density, native-not-decorative craft, fast under real use. `DESIGN.md` is currently a seed (no code yet); re-run `/impeccable document` once components exist to capture real tokens.

## Coding

- Make sure to set up logs for code you write using Effect's logger methods so its easy to trace and debug issues.
- Use /effect-ts skill when writing effect code
- Use /module-design skill when creating new services
- Use /with-testing-principals skill when writing or updating tests
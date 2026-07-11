# dia

dia is a personal desktop application — a self-built alternative to Claude Desktop — that drives the user's local Claude installation via the Anthropic TypeScript Agent SDK.

## Architecture decisions

All significant architecture and tech-stack decisions are recorded as ADRs in `docs/adr/`, written in MADR format. **Before proposing or changing anything architectural (process model, framework, build tooling, styling, repo layout), read the existing ADRs in `docs/adr/` first** — do not contradict an accepted decision without first surfacing the conflict to the user and, if they agree to change course, writing a new ADR (or superseding the old one).

See `docs/adr/README.md` for the index of current decisions.

When a new significant architecture decision is made during a session, write it up as a new ADR using `docs/adr/template.md`, following the numbering convention (`NNNN-short-title.md`), and add it to the index in `docs/adr/README.md`.

## Reference docs

- `docs/llms/electron-vite.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the electron-vite guide (build tool chosen in ADR-0004). Consult it before making electron-vite config, dev/HMR, build, or packaging changes.
- `docs/llms/agent-sdk.txt` — an [llms.txt](https://llmstxt.org/#proposal) index of the Claude Agent SDK docs (the SDK dia uses to drive Claude, per ADR-0003). Consult it before making changes involving sessions, permissions, hooks, MCP, subagents, or the Agent SDK's TypeScript API.

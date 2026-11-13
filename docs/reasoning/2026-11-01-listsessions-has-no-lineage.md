# `listSessions` reports no session lineage, and `includeProgrammatic: false` hides dia's sessions

**Date:** 2026-11-01

## Context

#96 imports the sessions Claude Code holds for a directory when a project is added. The design had to decide whether sessions chained by `/clear` or a fork could be grouped into one agent, and which `listSessions` options to pass. Probe on Agent SDK 0.3.311 and Claude Code 2.1.316, in the scratch directory `F:\Dev\.scratch\dia-96\exp`.

## Reasoning / Learning

- **No lineage.** `SDKSessionInfo` has `sessionId`, `summary`, `lastModified`, `fileSize`, `customTitle`, `firstPrompt`, `gitBranch`, `cwd`, `tag` and `createdAt`; no field names a parent session. A session made with `claude -p --resume <id> --fork-session` copies the messages with new uuids, and its `.jsonl` contains no occurrence of `<id>`. `/clear` also starts an unlinked session (`docs/reasoning/2026-10-31-agent-sessions-clear-and-removal-race.md`). Grouping sessions into agents after `host.db` rows are gone is therefore not possible without comparing message content.
- **`includeProgrammatic: false` returns nothing for dia.** It drops sessions with an SDK entrypoint (`sdk-cli`, `sdk-ts`, `sdk-py`). dia's sessions record `entrypoint: "sdk-ts"`. The probe's `claude -p` sessions also recorded `sdk-ts`, because the shell that ran them was started by an Agent SDK process and inherited its entrypoint; the entrypoint does not tell dia's sessions from CLI sessions.
- **`includeWorktrees` defaults to `true`.** With it, `listSessions({ dir })` also returns sessions of the repo's other git worktrees, which cannot resume in `dir`.
- `listSessions({ dir })` returned the two sessions newest first, each with `cwd` equal to the directory and `customTitle` equal to the AI title (`"Remember word PELICAN"`).

## Implication

The import makes one agent per session, calls `listSessions({ dir, includeWorktrees: false })` with the default `includeProgrammatic`, and drops a session whose `cwd` names another directory (`plugins/dia-claude-code/discovery.ts`, `docs/designs/project-agent-import.md`).

# The Executive assistant's run is not `dontAsk`; a built-in's allow list does not reach an edited one

**Date:** 2026-11-18

## Context

Issue #293 gives the Executive assistant org tools and allows only `mcp__dia__org_read` without a prompt. `docs/adr/0071-executive-assistant-session.md` says the Assistant's session "runs in `dontAsk`", which would deny every other org tool instead of prompting for it. The issue also asks for a migration that adds `org_read` to the Executive assistant's allow list.

## Reasoning / Learning

- `plugins/dia-org/assistant.ts` starts the Assistant's run with `runSettings(deps.backend, jobTitle, deps.directory, jobTitle.bypassOptIn)`, the same choice as a hire's run: `startPermissionMode` (`src/host/session/start-permission-mode.ts`) returns `auto` when the model supports it, `bypassPermissions` when the job title opts in, and `default` otherwise. It never returns `dontAsk`. A dia tool off the allow list therefore goes through the session's permission rules: it prompts in `default`, and the classifier decides in `auto`.
- Built-in job titles are not stored in the org database. `org` registers `BUILT_IN_DEFINITIONS` with the `agent-definitions` registry on every launch (`registerBuiltIns` in `plugins/dia-org/host.ts`), so a change to a built-in's fields in code reaches every org whose built-in was never edited. A user's edit is stored as an override in `agent-definitions` and replaces the code's fields, including `permissions`. An org migration sees only the org database and cannot change that override.
- `grantOrgRead` (`plugins/dia-org/handover.ts`) edits the override through the registry once per org database; migration `13_org_read_grant` records that the grant is pending. It waits while `job_titles_handover` exists, because the handover can import an override after the grant would have run; `plugins/dia-org/host.ts` calls it again after `handOverJobTitles`.

## Implication

Treat ADR-0071's `dontAsk` sentence as out of date. To change a built-in job title's permissions for orgs that edited it, add a one-time registry edit of this kind; changing `built-in-job-titles.ts` alone does not reach them.

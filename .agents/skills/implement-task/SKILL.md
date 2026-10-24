---
name: implement-task
description: "Takes a dia task from request to open PR: understand it, design it with module-design, implement and test it on a feature branch, verify it in the real app, then raise the PR through the simplify, code-review and proof gate."
argument-hint: "[task-description-or-issue]"
disable-model-invocation: true
---

# Implement a dia task end to end

Run the phases below in order. Each phase ends on a completion criterion; do not start the next phase until it is met.

**Resume** before starting: if this task already has a branch, a spec under `docs/designs/`, commits or an open PR, tell the user which phase you infer the task is in and why, and wait for their confirmation before skipping **Understand** or **Design**. Their completion criteria are user confirmations, which leave no artifact to check.

## Understand

Read the task source in full: the argument, a linked GitHub issue (`gh issue view`), a Linear issue, or a task file under `.draekien/break-down-prd/`. Then read what governs the area it touches: the ADR index `docs/adr/README.md` and the reasoning index `docs/REASONING.md`, and every entry for that area. Read the code the task will change.

Write down, and confirm with the user:

- **Scope** — what changes and what explicitly does not.
- **Success criteria** — each one observable in a test or in the running app, so `verify-in-app` can prove it later. "Closing a worktree pane removes the worktree directory" is a criterion; "worktrees work better" is not.
- **Runtime effect** — whether the change alters what the app does at runtime. A change to docs, skills or CI config does not; **Verify** is then skipped.
- **Conflicts** — any ADR the task would contradict. Raise it with the user before designing; if they agree to change course, **Design** writes a new ADR or supersedes the old one.

Put open decisions to the user one at a time with options and a recommendation, using the `get-aligned` skill (`/plugin install productivity-skills@draekien-skills`, or `npx skills add draekien/skills --skill "get-aligned"`).

Completion criterion: the user has confirmed the scope, the success criteria and the runtime effect, and no open decision remains.

## Branch

1. Run `git fetch origin`.
2. If `git status --porcelain` prints anything, stop and ask the user what to do with those changes; `git switch -c` would carry them onto the new branch.
3. Run `git switch -c <type>/<slug> origin/main`, where `<type>` is the conventional-commit type of the change (`feat/lazy-plugin-loading`, `fix/reattach-unregistered-worktree`). For a stacked task, branch from the parent branch instead and keep its name: **Raise the PR** passes it as the base.

Completion criterion: `git branch --show-current` prints the new branch, before the design spec or any code is written.

## Design

Invoke the `module-design` skill in `design` mode on the module the task creates or changes (`/plugin install software-design-skills@draekien-skills`, or `npx skills add draekien/skills --skill "module-design"`). Hand it the scope and success criteria from **Understand** so it does not interview for them again. A change confined to one method or class runs `module-design` at that scope, and its spec stays in chat.

Completion criterion: `module-design` has finished its rounds, the user has replied at its gate, and the spec is written to `docs/designs/` (or held in chat at method or class scope).

## Implement

For a bug fix, first write the reproducing test under **Test**, run it, and record that it fails; the PR reports it as red before the change.

Build the design as specified. Where the code shows the spec is wrong, stop, update the spec, and tell the user what changed and why; the PR body cites the spec, so it must match the code.

Invoke the skills the root `CLAUDE.md` mandatory-skill table requires before each edit it covers. Commit in small steps with conventional-commit messages.

Completion criterion: every part of the spec is implemented, and the diff contains nothing the spec does not call for except tests and `docs/reasoning/` entries.

## Test

Invoke the `testing-principles` skill (`/plugin install quality-skills@draekien-skills`, or `npx skills add draekien/skills --skill "testing-principles"`) and write a test for each success criterion a test can observe.

Run `pnpm test` and `pnpm typecheck` (judge `pnpm typecheck` by its exit code, as the root `CLAUDE.md` states).

Completion criterion: every success criterion maps to a passing test or is listed for **Verify**; both commands exit 0.

## Verify

Skip this phase when **Understand** recorded no runtime effect.

Run the `verify-in-app` skill with the success criteria from **Understand**. Keep its proof record for the PR body.

Completion criterion: every success criterion has an observation from the running app, or an entry in the proof record's "Not exercised" list with its reason.

## Raise the PR

Run the `raise-pr` skill, passing `--base <parent-branch>` for a stacked task. It runs the `/simplify` and `/code-review medium --fix` passes, re-runs the checks, refreshes the proof if those passes changed runtime code, and opens the PR. For a change with no runtime effect, tell it that no app run was made.

Completion criterion: the PR URL is reported to the user.

## Gotchas

- **Do not skip Design because the change looks small.** A small change still gets a design at method scope; that is the cheapest point to find a broken assumption.
- **Do not edit on `main`.** The spec `module-design` writes is a file change too.
- **Record what took effort to establish.** A root cause or library quirk found during the task goes in `docs/reasoning/` per the root `CLAUDE.md`, in the same branch.

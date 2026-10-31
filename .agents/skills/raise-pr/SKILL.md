---
name: raise-pr
description: "Raises a dia pull request through the blocking pre-PR gate: simplify and code-review passes, green checks, proof the change works in the real app, and a conventional-commit title. Use before every `gh pr create` in this repo, or when the user says \"raise a PR\", \"open a PR\", \"ship this branch\"."
argument-hint: "[--base <branch>]"
---

# Raise a dia pull request

Every PR in this repo goes through this gate, in order, on the branch diff against its base (`main` unless `--base` names the parent of a stacked branch). A reviewer reads the PR body instead of re-running the change, so the body must carry **proof**: evidence a reader can check, not a statement that the change works.

## Preconditions

- On a feature branch, not the base. Work is committed with conventional-commit messages.
- The change is implemented and its tests are written. If tests are missing, write them first under the `testing-principles` skill (`/plugin install quality-skills@draekien-skills`, or `npx skills add draekien/skills --skill "testing-principles"`).

## Gate — run in this order

Each step reviews the output of the one before, so the order is fixed. Run steps 1 and 2 only over the code files in the branch diff (`.ts`, `.tsx`, `.js`, `.mjs`, `.css`). Skip both steps when the diff changes no code file, for example a diff of only docs, skills, config, `.gitignore` or `.impeccable/` files, and state the skip in the PR body. `.impeccable/` files are never reviewed: they are impeccable's generated design records.

1. **Simplify.** Run `/simplify` (built in) over the branch diff and apply its verified fixes. Note every finding you do not apply, with the reason.
2. **Review.** Run `/code-review medium --fix` (built in). Note every finding it does not fix, with the reason.
3. **Checks.** Run `pnpm typecheck` (judged by exit code, as the root `CLAUDE.md` states), `pnpm lint` and `pnpm test`. Fix every failure, re-run all three, and commit the fixes from steps 1–3. If a check still fails after one fix attempt per failure, stop and report the failing command and its output to the user instead of opening the PR.
4. **Proof.** Skip for a change with no runtime effect (docs, skills, CI config); its proof is the check that exercises it — the validator run, the workflow run. Otherwise run the `verify-in-app` skill when no proof record exists for this branch, or when `git diff --stat <proof-commit>..HEAD` shows a change under `src/` or `plugins/` since the commit the record names.

Completion criterion: all three checks pass on the committed head, the working tree is clean, and a proof record exists that is current by the rule in step 4.

## Open the PR

1. Push the branch with upstream tracking.
2. Write the body from [assets/pr-body.md](assets/pr-body.md). Replace every `<...>` placeholder; leave none. **Not covered** lists each affected behaviour that the proof did not exercise; an empty list is a claim that the proof reached everything, so check it before writing "none".
3. Title it as a conventional commit, the same form as the commit log: `fix(plugins): reattach a worktree whose directory exists but is not registered`.
4. Create it with `gh pr create --base <base> --title <title> --body-file <file> --attach <file> ...`, passing every screenshot and recording from the proof record. Run it from the directory that holds the media: gh uploads each `--attach` file and rewrites the body's `![alt](./<file>)` reference to the uploaded URL; a video becomes a player. To add media to an open PR, run `gh pr edit <n> --body-file <file> --attach <file> ...`. `--attach` needs gh 2.100.0 or later (`gh --version`).
5. Register the PR with the current thread through `link_pull_request` when that tool is available. If the call fails, report its error text to the user with the PR URL; do not recreate the PR.

Completion criterion: the PR URL is reported to the user, its body shows check results, the proof and the **Not covered** list, and `gh pr view <n> --json body` shows a `github.com/user-attachments/` URL for every attached file.

## Gotchas

- **Show the proof; do not describe it.** A behaviour visible in the app gets its screenshot or recording in the body, with one line of caption. A value with no visible effect goes in a table row (`Case | Observed`), not a paragraph.
- **Do not paraphrase proof.** `pnpm test` 45 files / 533 tests passed is proof; "tests pass" is not. Quote counts, exit codes and observed values.
- **Report each review finding that was not fixed**, from both `/simplify` and `/code-review`, with its reason.
- **Do not commit with `--no-verify`.** Fix the diagnostic the hook reports.

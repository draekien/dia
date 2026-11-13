# Matching `.worktreeinclude` with `git ls-files` and `git check-ignore`

**Date:** 2026-11-01

## Context

Issue #78 copies the gitignored files a project's `.worktreeinclude` matches into each tab worktree. Claude Code's own rule ([Copy gitignored files into worktrees](https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees)): the file uses `.gitignore` syntax, and "only files that match a pattern and are also gitignored are copied". That copy runs only for worktrees Claude Code creates; dia creates its worktrees with `git worktree add`. The issue left open whether `git ls-files --others --ignored --exclude-from=.worktreeinclude` followed by `git check-ignore --stdin` is fast with a large ignored `node_modules`, how it treats `**/` patterns inside wholly ignored directories, and what it does with nested `.worktreeinclude` files and `!` negation.

## Reasoning / Learning

Measured on git 2.47.1.windows.2 in a throwaway repo (`.gitignore`: `.env*`, `node_modules/`, `config/secrets.json`, `.claude/`, `vendor/`):

- **Pipeline.** `git ls-files -z --others --ignored --exclude-from=<file>` lists untracked files that match `<file>`'s patterns ([git-ls-files](https://git-scm.com/docs/git-ls-files): `--others` shows untracked files, `--ignored` shows only the files the exclude patterns match). With only `--exclude-from`, git does not apply `.gitignore` here, so the list includes untracked files that are not gitignored (`notes.txt`). `git check-ignore -z --stdin` prints only the paths `.gitignore` ignores and never an indexed path ([git-check-ignore](https://git-scm.com/docs/git-check-ignore): "By default, tracked files are not shown at all since they are not subject to exclude rules"). Tracked `package.json` is dropped by `--others`, and `notes.txt` by `check-ignore`. dia runs both as one Effect `ChildProcess.pipeTo` pipeline in the project directory.
- **Speed.** With 100 000 ignored files under `node_modules` (2 000 packages × 50 files), the pipeline took 0.47–0.48 s; without them 0.10 s. `ls-files` walks every untracked directory, because no `.gitignore` tells it `node_modules` is ignored. A worktree add takes 1–2 s on the same machine, so the cost was accepted. The faster `git ls-files --others --ignored --exclude-standard --directory` (0.09 s; lists `node_modules/` as one entry) would need a second gitignore matcher in JavaScript over its output.
- **`**/` inside a wholly ignored directory.** `**/config.json` matched `vendor/x/config.json` although `vendor/` is ignored as a whole. Claude Code copies such a file only when the directory or the first name after `**/` is in the path, so dia copies a superset of what Claude Code copies. A pattern without a slash, such as `.env`, matches at every depth (`sub/.env`, `sub/deep/.env`), as in `.gitignore`.
- **Negation.** `.env*` then `!.env.production` excluded `.env.production`; `!` works as in `.gitignore`.
- **Nested files.** `--exclude-from` reads only the named file, so `vendor/.worktreeinclude` (`other.txt`) was ignored. `--exclude-per-directory=.worktreeinclude` would read it (it then listed `vendor/x/other.txt`), but Claude Code documents only the project-root file, so dia does not.
- **Copy failures.** A file held open with `FileShare.None` fails `copyFile` with `EBUSY`. The Node error message is `EBUSY: resource busy or locked, copyfile '<src>' -> '<dst>'`; dia shows the part before the first `, ` so the reason does not repeat both paths.

`plugins/dia-worktrees/worktree-include.test.ts` runs the matching cases against real git.

## Implication

- Change the matching only together with that test; a JavaScript matcher would have to reproduce git's `.gitignore` semantics.
- If a large include pattern makes tab setup slow, the cost is the `ls-files` walk over ignored directories, not the copy.

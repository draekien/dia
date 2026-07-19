---
name: tag-release
description: "Cut a new dia release: bump the version and push a git tag so CI builds and publishes the installer. Reach for this when shipping a new version."
argument-hint: "[patch|minor|major]"
---

# Tag a dia release

Releasing dia is a **tag-and-push** operation, not a local build. Pushing a
`v*` git tag triggers the `release` GitHub Action, which runs `pnpm release`
(electron-builder) on a clean runner and publishes the NSIS installer plus
`latest.yml` to a GitHub Release. Your job is to bump the version, create the
tag, and push it — CI does everything else.

## The one rule that overrides your instinct

**Never build or publish the release locally.** Do not run `pnpm release`,
`electron-builder --publish`, or any variant on your machine. Local publishing
races the CI run, can push mismatched artefacts, and bypasses the clean-room
build that installed clients auto-update against. The tag push *is* the release.

## Preflight — clear every gate before tagging

CI builds but does **not** run the test suite or type checks, so a broken commit
tags and ships silently. Establish a healthy `main` before creating the tag:

- **On `main` with a clean working tree.** `pnpm version` refuses to run against
  uncommitted changes; more importantly, the tag must point at reviewed,
  committed code. Confirm `git status` is clean and the branch is `main`.
- **Health checks green.** Run `pnpm typecheck`, `pnpm diagnostics`,
  `pnpm test`, and `pnpm lint`. All must pass — a failure here is a stop, not a
  warning to note and push past.
- **`main` pushed and up to date with origin.** The tag's commit must already be
  on the remote branch so the release history is coherent.

Completion criterion: every check above passes and `git status` shows a clean
tree on `main`. Do not proceed on a red check.

## Bump, tag, and push

1. **Choose the bump level.** dia is pre-1.0, so default to `patch`; use `minor`
   for a notable feature set and `major` only on the user's explicit call. If the
   argument names a level, use it; otherwise infer from the change and state your
   choice.

2. **Bump and tag in one step** — this bumps `package.json`, commits, and creates
   the `v`-prefixed tag. Never hand-edit the version in `package.json`; the
   package manager owns that number.

   ```sh
   pnpm version <patch|minor|major> --message "chore(release): v%s"
   ```

   Read the printed result (`dia: X.Y.Z → A.B.C`). The new tag is `vA.B.C`.

3. **Push the branch and the tag.** A bare `git push` does not push tags — push
   the tag explicitly, or the release never triggers.

   ```sh
   git push origin main
   git push origin vA.B.C
   ```

## Confirm CI picked up the tag

A pushed tag that fails to start a run is a silent no-op. Verify the `release`
workflow is running against the new tag:

```sh
gh run list --workflow=release.yml --limit 3
```

The top row must show the new tag with an `in_progress` (or queued) status.
Report the run to the user. The build takes several minutes; when it finishes,
the GitHub Release for the tag should carry `dia-Setup-A.B.C.exe` and
`latest.yml` — those two files are what installed clients auto-update against.

Completion criterion: the tag push has produced a `release` run for that exact
tag, confirmed in the run list.

## Gotchas

- **Draft releases don't auto-update.** electron-updater ignores drafts, so
  `electron-builder.yml` sets `releaseType: release`. If a release publishes as a
  draft, that config regressed — clients won't see the update.
- **The `v` prefix is load-bearing.** The workflow triggers on `v*`. `pnpm
  version` prefixes tags with `v` by default; don't strip it or create the tag
  by hand without it.
- **A failed run leaves a published tag behind.** If CI fails, the tag still
  exists. Fix forward with a new patch tag rather than deleting and re-pushing a
  released tag — moving a tag installed clients may have already seen causes
  update-integrity problems.

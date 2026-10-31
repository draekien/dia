---
status: "accepted"
date: 2026-10-31
decision-makers: William Pei
---

# Publish a nightly build of `main` as a side-by-side `dia-nightly` app

## Context and Problem Statement

ADR-0016 publishes dia only when a `v*` tag is pushed, so a change merged to `main` reaches the installed app only after a manual `tag-release`. William wants to run the latest `main` without cutting a stable release, while keeping a stable install to fall back to. Since ADR-0042 and ADR-0043, all Host state lives in SQLite under `userData`, so a build with newer migrations cannot safely open a stable install's data. How should builds of `main` reach the machine?

## Decision Drivers

* A broken or newer build of `main` must not change the stable install's `userData`.
* Builds must reach the machine through the existing electron-updater GitHub feed, with no new infrastructure.
* The stable release process in ADR-0016 and the `tag-release` skill must not change.

## Considered Options

* A side-by-side app with its own identity, built nightly from `main`, published as GitHub prereleases
* A channel switch inside the stable app (electron-updater `channel` / `allowPrerelease`)
* Publish every merge to `main` as a normal release, replacing tagged releases
* Build on every push to `main` instead of nightly

## Decision Outcome

Chosen option: **a side-by-side `dia-nightly` app built nightly from `main`**, because it is the only option that keeps the stable install's `userData` untouched by newer builds.

`.github/workflows/nightly.yml` implements it:

| Aspect | Value |
| --- | --- |
| Schedule | `cron: '17 2 * * *'`, `timezone: 'Australia/Sydney'`, plus `workflow_dispatch`; runs only on `refs/heads/main` |
| Skip rule | No build when `git diff` from the highest `v*-nightly.*` tag to `HEAD` touches none of `src`, `plugins`, `build`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `electron-builder.yml`, `electron.vite.config.ts` (excluding `*.test.ts`, `*.test.tsx`, `*.md`). The first run always builds. |
| Version | `<package.json version with patch + 1>-nightly.<highest N for that base + 1>`. With stable `0.0.15`: `0.0.16-nightly.1`, `0.0.16-nightly.2`; after `v0.0.16` ships: `0.0.17-nightly.1`. |
| Identity | `appId` `com.draekien.dia.nightly`, `productName` `dia-nightly`, packaged `package.json` `name` `dia-nightly`, so `userData` is `%APPDATA%\dia-nightly` and the updater cache is `%LOCALAPPDATA%\dia-nightly-updater` |
| Feed | GitHub prerelease `v<version>` on `draekien/dia` with `nightly.yml`; the release is created as a draft at `$GITHUB_SHA` and published after upload |
| Retention | The 5 highest nightly prereleases and their tags; older ones are deleted after each publish |

The nightly app needs no code change to follow the nightly feed. electron-updater 6.8.12 sets `allowPrerelease` to true when the running version has a prerelease component, and its GitHub provider then selects only releases whose tag's first prerelease identifier equals the running one (`nightly`). The stable app keeps `allowPrerelease` false and reads `GET /repos/{owner}/{repo}/releases/latest`, which excludes prereleases. `release.yml` ignores `v*-nightly.*` tags.

### Consequences

* Good, because stable and nightly run at the same time with separate `userData`, single-instance locks and updater caches.
* Good, because a night with no shipped change starts no Windows runner and publishes nothing.
* Bad, because the nightly app does not share the stable app's workspace, settings or worktrees.
* Bad, because the first nightly install is a manual download of the installer from a prerelease.
* Bad, because GitHub disables a public repository's scheduled workflows after 60 days with no repository activity; it is re-enabled by a commit to the workflow's `cron` or from the Actions tab.

## Pros and Cons of the Options

### Side-by-side app, nightly

* Good, because a newer migration in the nightly cannot reach the stable `host.db`.
* Good, because it matches the separate-install model of VS Code Insiders and Chrome Canary.
* Bad, because it is a second install with its own data.

### Channel switch inside the stable app

* Good, because there is one install and one data directory.
* Bad, because returning to stable opens a `host.db` migrated by a newer build.

### Every merge as a normal release

* Good, because there is one pipeline.
* Bad, because there is no stable build to fall back to.

### Build on every push to `main`

* Good, because a fix reaches the machine minutes after merge.
* Bad, because a burst of merges produces one build and one update download per merge.

## More Information

- Amends ADR-0016: tagged pushes remain the whole stable release process; nightly builds are a second, independent channel.
- Workflow: `.github/workflows/nightly.yml`. Stable workflow: `.github/workflows/release.yml`.
- Why the nightly overrides `name` and not `productName`: `docs/reasoning/2026-10-31-electron-builder-identity-from-package-name.md`.
- Verified on 2026-10-31 by a local `electron-builder --win --publish never` with the workflow's `-c` overrides, which produced `nightly.yml`, `dia-nightly-Setup-0.0.16-nightly.1.exe`, and an `app-update.yml` with `channel: nightly` and `updaterCacheDirName: dia-nightly-updater`. The first published nightly is unverified until the workflow runs on `main`.

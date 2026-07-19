---
status: "accepted"
date: 2026-07-19
decision-makers: William Pei
---

# Distribute dia as an electron-builder NSIS installer with GitHub-backed auto-update

## Context and Problem Statement

The dogfooding milestone (G-1, Bullet 10) requires William to *use* dia for real work
rather than run it via `electron-vite dev`, whose hot-reload restarts the main process and
kills in-flight agent sessions. dia therefore needs to be built into an installable desktop
application that persists across launches and can update itself. ADR-0004 chose electron-vite
for *building* the app into `out/`, but electron-vite explicitly does not package or
distribute — it defers that to electron-builder or Electron Forge. How should dia be packaged
and delivered?

## Decision Drivers

* Single-user, personal use on Windows 11 — no cross-platform or store-distribution need.
* Must survive real dev sessions (no dev-server teardown of running panes).
* Should update itself so dogfooding builds don't require a manual rebuild each time.
* The Agent SDK spawns the Claude Code CLI and native helper binaries as child processes,
  which constrains how the app can be archived.

## Considered Options

* electron-builder (NSIS installer) + electron-updater, publishing to GitHub Releases
* Electron Forge
* npm global install (`npm i -g`) of dia as a package with an Electron-launching bin

## Decision Outcome

Chosen option: **electron-builder producing an unsigned Windows NSIS installer, with
electron-updater checking GitHub Releases on `draekien/dia`**, because electron-vite documents
electron-builder integration directly, NSIS gives a real installed app with its own userData
directory and OS integration, and the GitHub provider needs no extra infrastructure. A GitHub
Actions workflow builds and publishes the installer (plus the `latest.yml` update feed) on
`v*` tag pushes. The repository is made public so the updater reads releases without an
embedded token. Code signing is skipped (personal use; SmartScreen is clicked through once).

### Consequences

* Good, because the installed app is decoupled from the dev toolchain and survives restarts,
  and auto-update means a tagged push is the whole release process.
* Good, because `asarUnpack`-ing `@anthropic-ai/claude-agent-sdk` keeps the Claude CLI and its
  binaries spawnable (they cannot execute from inside an asar archive).
* Bad, because the app is unsigned, so Windows SmartScreen warns on first run.
* Bad, because auto-update is macOS-incompatible without signing — acceptable while dia is
  Windows-only.
* Bad, because publishing releases without an embedded token required making the source repo
  public (an outward-facing, effectively irreversible change).

## Pros and Cons of the Options

### electron-builder + electron-updater (GitHub)

* Good, because it is the path electron-vite documents, with first-class NSIS + GitHub support.
* Good, because electron-updater's GitHub provider needs only a public repo and CI token.
* Bad, because electron-builder's dependency collection can be finicky under pnpm's symlinked
  store (see the reasoning log entry).

### Electron Forge

* Good, because it is an alternative first-class packager.
* Bad, because it overlaps electron-vite's Vite pipeline and offers no advantage here over the
  electron-builder path electron-vite already documents.

### npm global install

* Good, because it installs from the command line.
* Bad, because it is an unconventional model for a GUI Electron app: it depends on `electron`
  per-install, needs the build toolchain on the target, has no OS integration, and drops
  electron-updater entirely (updates become a manual `npm i -g`).

## More Information

- Packaging config: `electron-builder.yml`; scripts `build:win` / `release` in `package.json`.
- CI: `.github/workflows/release.yml` (Windows runner, publishes on `v*` tags).
- The asar/Claude-CLI constraint is recorded in
  `docs/reasoning/2026-07-19-packaging-asarunpack-claude-cli.md`.


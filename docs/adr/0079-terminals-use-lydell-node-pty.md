---
status: accepted
date: 2026-11-13
decision-makers: William Pei (decision taken by the implementing agent without the user, under the user's instruction to proceed without asking)
---

# Run terminals through `@lydell/node-pty`, a native module with N-API prebuilds and no install script

## Context and Problem Statement

Step 12 of `docs/plans/2026-11-13-foundation.md` adds terminals: a plugin opens a pseudo-terminal (PTY) in a run's working directory and the renderer shows it. Node has no PTY API; every PTY library for Node is a native module. ADR-0042 lists "The installer must not gain native modules or binaries to unpack" as a decision driver, and chose `node:sqlite` partly because it met it. Which PTY library does dia use, and what does that mean for ADR-0042's driver?

## Decision Drivers

* A terminal must be a real PTY: shells print a prompt, programs see a TTY and keep colour and interactive output.
* `pnpm install --frozen-lockfile` in CI (Windows) must work with no compiler and no `allowBuilds` change.
* An Electron upgrade must not need a matching binary release of the library.
* The packaged installer must start on a Windows machine with nothing else installed.

## Considered Options

* `@lydell/node-pty`
* Microsoft `node-pty` 1.1.0
* `@homebridge/node-pty-prebuilt-multiarch`
* `child_process` with pipes, no PTY

## Decision Outcome

Chosen option: "`@lydell/node-pty`", because it is the only PTY option with no install script and an ABI-independent prebuilt binary. It repackages Microsoft's `node-pty` 1.2 beta as one JavaScript package and one optional package per platform (`@lydell/node-pty-win32-x64` holds `conpty.node`, built with N-API, so it loads in any Electron without a rebuild).

This amends ADR-0042's driver "The installer must not gain native modules or binaries to unpack": the driver applies to storage, where `node:sqlite` removes the need. A capability with no pure-JavaScript or built-in option may use a native module that has no install script and ships N-API prebuilds for `win32-x64`, unpacked through `asarUnpack` and loaded from its `app.asar.unpacked` path.

### Consequences

* Good, because CI's `pnpm install --frozen-lockfile` installs it with no build step.
* Good, because N-API binaries need no rebuild for a new Electron.
* Bad, because it is a beta (1.2.0-beta.18) repackaged by a third party; an upgrade checks that the platform package still ships `conpty.node` with no install script.
* Bad, because `electron-builder.yml` must unpack `node_modules/@lydell/**`, and the plugin must load the package from `app.asar.unpacked`: node-pty starts a worker script from its own directory, and its path rewrite matches `node_modules.asar`, not `app.asar` (`lib/windowsConoutConnection.js`).
* Bad, because the installer grows by the Windows platform package (about 12 MB unpacked, including debug symbols and `OpenConsole.exe`, which dia does not use).

## Pros and Cons of the Options

### Microsoft `node-pty` 1.1.0

* Good, because it is the stable upstream release, and t3code and deepseek-harness use upstream `node-pty` (1.2 beta).
* Bad, because its install script (`node scripts/prebuild.js || node-gyp rebuild`) is blocked by pnpm until `allowBuilds` names it, and falls back to a compiler.
* Bad, because it has no Linux prebuild, and ships winpty, which dia does not use.

### `@homebridge/node-pty-prebuilt-multiarch`

* Good, because it ships prebuilds for many platforms.
* Bad, because `prebuild-install` downloads an ABI-specific binary from GitHub at install time, so CI needs the network and an Electron upgrade needs a matching release.

### `child_process` with pipes, no PTY

* Good, because it needs no dependency.
* Bad, because programs see no terminal: shells print no prompt, and colour and interactive output are off.

## More Information

* Design: `docs/designs/dia-terminals.md`.
* Amends ADR-0042 (its decision driver on native modules). Related: ADR-0016 (installer), ADR-0076 (the "Terminals and processes" capability).

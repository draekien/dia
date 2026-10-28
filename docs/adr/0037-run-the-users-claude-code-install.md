---
status: "accepted"
date: 2026-10-28
decision-makers: William Pei
---

# Run the user's own Claude Code install instead of the binary bundled with the Agent SDK

## Context and Problem Statement

The Agent SDK installs a platform package (`@anthropic-ai/claude-agent-sdk-win32-x64` and similar) that holds a Claude Code binary, and dia shipped that binary inside the installer (`asarUnpack` plus an `app.asar.unpacked` path rewrite in `plugins/claude-code/claude-executable.ts`). That binary's version is fixed by dia's release, not by the user, and it is a second Claude Code next to the one the user already runs from a terminal. Issue #50 asks dia to drive the user's installed Claude Code and to show whether that install works. Which Claude Code executable does dia run?

## Decision Drivers

* Agents in dia behave like `claude` in the user's terminal: same version, same sign-in, same configuration.
* Updating Claude Code must not require a new dia release.
* The installer must not carry a Claude Code binary it does not run.
* When no usable install exists, dia says so instead of running a different one.

## Considered Options

* Run the user's install, found by an override the user sets or on `PATH`, with no fallback (chosen).
* Run the user's install, and fall back to the bundled binary when none is found.
* Keep running the bundled binary.

## Decision Outcome

Chosen option: "Run the user's install, with no fallback", because it is the only option where the version, sign-in and configuration dia runs are always the user's own.

`plugins/claude-code/claude-install.ts` resolves the executable at each health check and each query start: the override stored in the adapter's data directory (`install.json`) when set, else `claude` on `PATH`. On Windows, a `.cmd`, `.bat` or `.ps1` shim on `PATH` resolves to the `claude.exe` or `cli.js` of the npm package it launches. A stored override that does not run is reported as an error; dia does not then try `PATH`. The resolved path is passed to the SDK as `pathToClaudeCodeExecutable`.

dia makes no version check of its own. The SDK reports an install that is too old for it as the startup failure `cli_version_too_old` (requested through `CLAUDE_CODE_STARTUP_FAILURE_RESULTS`), which the health check shows as "Update Claude Code".

### Consequences

* Good, because agents use the user's Claude Code version, sign-in and settings.
* Good, because the installer no longer carries the SDK's platform binary: `electron-builder.yml` excludes `node_modules/@anthropic-ai/claude-agent-sdk-*/**` and no longer unpacks it.
* Good, because installing Claude Code or changing the override applies to the next check and the next agent without restarting dia.
* Bad, because dia cannot start an agent on a machine without Claude Code; the Settings page, the composer and the New agent form say why.
* Bad, because a user's Claude Code can differ in version from the SDK dia was built with. Only an install the SDK reports as too old is refused.

## Pros and Cons of the Options

### Run the user's install, with no fallback

* Good, because what runs is always what the user installed.
* Bad, because a missing install blocks agents until the user installs Claude Code or sets the path.

### Run the user's install, and fall back to the bundled binary

* Good, because agents start on a machine without Claude Code.
* Bad, because the fallback runs a version, sign-in and configuration the user did not choose, without telling them.
* Bad, because the installer still carries the binary.

### Keep running the bundled binary

* Good, because the version dia runs matches the SDK exactly.
* Bad, because updating Claude Code needs a dia release, and agents differ from the user's terminal `claude`.

## More Information

* Issue #50 and the spec `docs/designs/adapter-settings.md`.
* Points 2 and 3 of `docs/reasoning/2026-07-19-packaging-asarunpack-claude-cli.md` are superseded by this ADR.

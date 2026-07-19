# dia

A personal desktop app that drives your local Claude installation via the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) — a
self-built alternative to Claude Desktop, built around running multiple agent
sessions in parallel panes.

> [!IMPORTANT]
> **This is an experimental personal project with no guaranteed support.**
> It's built for the author's own use and shared as-is — there are no
> guarantees of stability, maintenance, or help with issues. **External pull
> requests are not accepted.** You're welcome to fork it and build on it for
> your own needs.

## Prerequisites

dia drives your **local Claude installation**, so you need Claude Code installed
and authenticated on your machine (the same login you use for the `claude` CLI).
dia does not ship or manage those credentials; if `claude` works in your
terminal, dia can drive it.

## Installation

### Option 1 — Download the installer (recommended)

1. Go to the [latest release](https://github.com/draekien/dia/releases/latest).
2. Download `dia Setup <version>.exe`.
3. Run it. The build is unsigned, so Windows SmartScreen shows an
   "unknown publisher" warning the first time — choose **More info → Run anyway**.
4. dia installs to your user profile and adds a Start-menu (and optional desktop)
   shortcut.

Installed builds **update themselves**: on launch, dia checks the GitHub releases
for a newer version, downloads it in the background, and installs it the next time
you quit.

### Option 2 — Build the installer from source

Requires [Node.js 22+](https://nodejs.org) and [pnpm](https://pnpm.io) on Windows.

```sh
git clone https://github.com/draekien/dia.git
cd dia
pnpm install
pnpm build:win
```

The installer is written to `dist/dia Setup <version>.exe`. Run it as in Option 1.

## Development

Run dia against the dev server with hot-reload:

```sh
pnpm dev
```

Note that hot-reload restarts the main process and tears down any in-flight agent
sessions — for real day-to-day use, install a packaged build instead.

Other useful scripts:

| Script            | What it does                                  |
| ----------------- | --------------------------------------------- |
| `pnpm test`       | Run the test suite (Vitest)                   |
| `pnpm typecheck`  | Type-check all TypeScript projects            |
| `pnpm diagnostics`| Run Effect-aware diagnostics                  |
| `pnpm build:win`  | Build the Windows installer into `dist/`      |

## Releasing

Pushing a `v*` tag (e.g. `v0.1.0`) triggers the
[release workflow](.github/workflows/release.yml), which builds the Windows
installer and publishes it to GitHub Releases — where installed apps pick it up
as an auto-update. Bump the `version` in `package.json` to match the tag.

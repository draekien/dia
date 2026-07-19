# Packaging: the Agent SDK's Claude CLI must be unpacked from asar

**Date:** 2026-07-19

## Context

Packaging dia into an installable app (ADR-0016) for the dogfooding milestone. electron-builder
archives the app into `app.asar` by default. dia's panes spawn the Agent SDK, which in turn
spawns the bundled Claude Code CLI (`@anthropic-ai/claude-agent-sdk`) and its native helper
binaries (ripgrep, etc.) as child processes — dia sets no `pathToClaudeCodeExecutable`, so the
SDK's own bundled CLI is what runs.

## Reasoning / Learning

Binaries and scripts that get `spawn`/`fork`'d cannot execute from inside an asar archive —
Node can `require` JS out of asar, but the OS cannot exec a file that only exists as a virtual
path inside the archive. So `@anthropic-ai/claude-agent-sdk` must be listed under
`asarUnpack` in `electron-builder.yml`; electron-builder then places it in
`app.asar.unpacked/node_modules/...` and the SDK spawns fine. Without this the packaged app
launches but every pane fails at session start — a runtime-only failure invisible to
`pnpm build`, typecheck, and the dev server (dev runs unpacked from `node_modules`).

Two adjacent facts worth keeping:
- The pane subprocess itself (`utilityProcess.fork(join(import.meta.dirname,
  'pane-process/agent-session.js'))`, `pane-supervisor.ts`) is *dia's own* bundled JS and runs
  fine from inside asar — only the SDK's spawned binaries need unpacking.
- electron-builder's dependency collection can miss packages under pnpm's *symlinked* store,
  but dia already sets `nodeLinker: hoisted` in `pnpm-workspace.yaml`, so `node_modules` is a
  flat (npm-style) layout and the `asarUnpack` glob resolves to real files rather than a
  `.pnpm` symlink. If that ever reverts to the default symlinked linker, expect the SDK to be
  mis-collected and restore `hoisted`.
- pnpm 10+ gates dependency build scripts behind an `allowBuilds` allowlist in
  `pnpm-workspace.yaml`, and pnpm 11's pre-run dep check fails (blocking *every* `pnpm <script>`)
  while any newly-seen package sits unresolved there. Adding electron-builder pulled in
  `electron-winstaller` (Squirrel.Windows tooling dia doesn't use — the NSIS target is
  separate); it is set to `false` so its Squirrel-binary download is skipped.

## Implication

Any future dependency that dia (or the SDK) spawns as a process, or that ships a native
`.node`/`.exe`, must be added to `asarUnpack`. Verify packaging by actually launching the
installed build and opening a pane, not just by a green `pnpm build` — the failure mode is
exclusively at runtime in the packaged app.

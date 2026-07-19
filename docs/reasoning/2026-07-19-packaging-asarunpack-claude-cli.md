# Packaging: the Agent SDK's Claude CLI must be unpacked *and* pointed at explicitly

**Date:** 2026-07-19

## Context

Packaging dia into an installable app (ADR-0016) for the dogfooding milestone. electron-builder
archives the app into `app.asar` by default. dia's panes spawn the Agent SDK, which in turn
spawns the bundled Claude Code CLI (`@anthropic-ai/claude-agent-sdk`) and its native helper
binaries as child processes. This took three separate fixes; asarUnpack alone was **not**
enough, contrary to what the first version of this entry claimed.

## Reasoning / Learning

Three distinct things all had to be true for a pane's query session to start in the packaged
app. Each is a runtime-only failure invisible to `pnpm build`, typecheck, and the dev server
(dev runs unpacked from `node_modules`).

1. **The SDK must be externalized out of the bundled main process.** electron-vite builds
   `main` as SSR-like, and Vite's SSR resolver bundled `@anthropic-ai/claude-agent-sdk` into an
   `out/main/chunks/*.js` even though it was in rollup's `external` list and the (deprecated,
   auto-applied) externalize plugin was active. The effective knob is
   `ssr.external: ['@anthropic-ai/claude-agent-sdk']` in `electron.vite.config.ts`. If the SDK
   is bundled, its `import.meta.url`-based binary resolver anchors to the wrong path entirely.
   (Separately, keep `rollupOptions.external: ['electron']`: the electron npm package's
   installer code uses `__dirname` and crashes the ESM main process at startup if bundled —
   that presents as the *whole app* dying, including pane split/close, not just sessions.)

2. **The native binary package must be `asarUnpack`ed.** Binaries that get `spawn`'d cannot
   execute from inside an asar archive — the OS cannot exec a file that only exists as a virtual
   path inside the archive. `electron-builder.yml` lists
   `@anthropic-ai/claude-agent-sdk/**` and `@anthropic-ai/claude-agent-sdk-*/**` under
   `asarUnpack`, so electron-builder places them in `app.asar.unpacked/node_modules/...`.

3. **The SDK must be told the unpacked path via `pathToClaudeCodeExecutable`.** This is the
   piece asarUnpack alone misses. When unset, the SDK resolves the binary with
   `createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-<plat>-<arch>/claude<ext>')`,
   and in the packaged app `import.meta.url` sits *inside* `app.asar`, so it resolves to the
   asar **virtual** path (`…app.asar\…\claude.exe`), not the unpacked copy — the OS then fails
   to launch it ("exists but failed to launch"). `agent-session.ts` recomputes that resolve and
   rewrites the `app.asar<sep>` segment to `app.asar.unpacked<sep>`, passing the result as
   `pathToClaudeCodeExecutable`. In dev the same resolve returns a plain `node_modules` path
   with no `app.asar` segment, so the rewrite is a no-op and the SDK behaves normally.

Two adjacent facts worth keeping:
- The pane subprocess itself (`utilityProcess.fork(join(import.meta.dirname,
  'pane-process/agent-session.js'))`, `pane-supervisor.ts`) is *dia's own* bundled JS and runs
  fine from inside asar — only the SDK's spawned binaries need unpacking + redirecting.
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

When a session *does* fail here, the error arrives as a `SessionStreamError` whose `cause` is
`unknown`; Effect's logger serializes it to `{}`. The `catchAllCause` in `agent-session.ts`'s
`runSession` extracts the underlying `Error` via `Cause.failureOption` so the real message/stack
(e.g. the "failed to launch" text that named the asar path) is actually logged — keep it.

## Implication

Any future dependency that dia (or the SDK) spawns as a process, or that ships a native
`.node`/`.exe`, must be (a) externalized if bundled into main, (b) added to `asarUnpack`, and
(c) if the spawning code resolves it via `import.meta.url`, given an explicit unpacked path —
all three, not just one. Verify packaging by actually launching the installed build and opening
a pane, not just by a green `pnpm build` — the failure mode is exclusively at runtime in the
packaged app.

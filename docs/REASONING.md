# Reasoning Log

This is an index of non-obvious decisions, gotchas, and learnings recorded during development sessions. Unlike `docs/adr/`, which captures significant *architectural* decisions, `docs/reasoning/` captures smaller-grained findings — a tricky bug's root cause, a library quirk, a rejected approach and why — that don't warrant a full ADR but are worth remembering so they aren't rediscovered the hard way.

- `template.md` — the template used for new entries.
- `YYYY-MM-DD-short-slug.md` — one entry per learning, dated and named for what it's about.

## Index

| Date | Entry | Summary |
| --- | --- | --- |
| 2026-07-12 | [Vendored `.repos/effect` API drift](reasoning/2026-07-12-effect-vendored-repo-api-drift.md) | The `/effect-ts` skill's vendored clone tracks a newer/different Effect package than what's installed — verify signatures against `node_modules/effect`, not `.repos/effect`. |
| 2026-07-12 | [`Effect.fn` trailing transforms](reasoning/2026-07-12-effect-fn-trailing-transform.md) | `Effect.fn(name)(body, a, b, ...)` accepts pipe-transform args after the generator body, letting a blanket recovery live in the definition instead of every call site. |
| 2026-07-12 | [Decode IPC boundaries non-throwing](reasoning/2026-07-12-decode-ipc-boundary-non-throwing.md) | `Schema.decodeUnknownSync` inside a raw IPC/process message listener crashes the whole process on malformed input — always use `Either`/`Option` decode there. |
| 2026-07-12 | [shadcn CLI needs root tsconfig.json paths](reasoning/2026-07-12-shadcn-cli-needs-root-tsconfig-paths.md) | shadcn CLI reads the root `tsconfig.json` directly, not `tsconfig.web.json` via project references — `@renderer/*` must be duplicated there. Also: `pnpm add` can fail on Windows via the `prepare` script; `--ignore-scripts` is safe since `.repos/effect` already exists. |
| 2026-07-12 | [`Effect.forkScoped` requires ambient `Scope` at the fork site](reasoning/2026-07-12-forkscoped-requires-ambient-scope.md) | `Scope.Scope` availability depends on which fiber lineage forked the effect, not the function itself — a function forked from multiple call sites can't assume `Scope` is uniformly ambient; use `Effect.fork` + manual `Fiber.interrupt` when call sites differ. |
| 2026-07-12 | [Preload IPC listener fan-out](reasoning/2026-07-12-preload-ipc-listener-fanout.md) | One `ipcRenderer.on` per subscriber scales with `panes × event types` and trips Node's `MaxListeners` cap — register the raw IPC listener once and fan out to an internal `Set` of subscribers instead. |
| 2026-07-12 | [Self-interrupting settle fiber](reasoning/2026-07-12-self-interrupting-settle-fiber.md) | A forked timer fiber that recurses into a function reading back its own tracking `Ref` can interrupt itself before finishing — clear the ref before recursing, not after. |
| 2026-07-17 | [Worktree reattach resume incantation](reasoning/2026-07-17-worktree-reattach-resume-incantation.md) | Resuming a pane's worktree uses `git worktree add <path> <branch>` (no `-b`); recreating with `-b` fails on the existing branch and `-B` silently discards the pane's committed work. cwd must stay byte-identical or the SDK loses the transcript. |
| 2026-07-17 | [Effect diagnostics via `@effect/tsgo`](reasoning/2026-07-17-effect-tsgo-diagnostics-tooling.md) | `@effect/tsgo` patches the native `tsc` so `tsc -p <config>` emits Effect diagnostics per that config's `diagnosticSeverity` map (arrays replace across `extends`, don't merge); relax test-only rules via a dedicated `tsconfig.test.json`, bust `.tsbuildinfo` after severity changes, and use `Effect.gen`+`withSpan` (not an immediately-invoked `Effect.fn`). |
| 2026-07-17 | [Tool-call completion = tool_result, not content_block_stop](reasoning/2026-07-17-tool-call-completion-semantics.md) | `ToolCallCompleted` must fire when the `type: 'user'` `tool_result` arrives (correlated by `tool_use_id`), not at `content_block_stop` (which is only when input finished streaming) — otherwise the running-tool indicator clears before the tool executes. SDK→protocol mapping lives in the pure, tested `agent-session-reducer.ts`. |
| 2026-07-17 | [Streaming text smooth reveal](reasoning/2026-07-17-streaming-text-smooth-reveal.md) | SDK text deltas arrive in irregular bursts, so animating per-delta is jerky by construction — decouple the visual cadence with a `requestAnimationFrame` loop that reveals a buffered string at a proportional catch-up rate (effect runs once, reads target from a ref). |
| 2026-07-18 | [Self-hosted fonts via CSS `@import`](reasoning/2026-07-18-self-hosted-fonts-via-css-import.md) | Load `@fontsource-variable/*` fonts with `@import` in `index.css`, not a JS side-effect import (a bare specifier trips `TS2882`); they self-host into `out/renderer/assets/*.woff2` and wire up as `--font-sans`/`--font-mono` theme tokens. |
| 2026-07-18 | [Light / dark / system theming](reasoning/2026-07-18-light-dark-system-theming.md) | Class-based dark mode needs `@custom-variant dark`; syntax highlighting is hand-authored `--syntax-*` role vars (hljs theme files can't be class-scoped via `@import`); the startup theme flash is an accepted tradeoff of async main-process persistence. |

## Adding a new entry

Copy `template.md` to `YYYY-MM-DD-short-slug.md`, fill it in, and add a row to the index above. Only add entries for genuinely non-obvious findings — not routine implementation notes.

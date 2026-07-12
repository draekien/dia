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

## Adding a new entry

Copy `template.md` to `YYYY-MM-DD-short-slug.md`, fill it in, and add a row to the index above. Only add entries for genuinely non-obvious findings — not routine implementation notes.

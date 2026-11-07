# Meta repo

Status: implemented for issue #16 (agent OS plan step 5, ADR-0025).

## Purpose

The `meta` feature plugin creates the meta repo on first start and supplies what it adds to every new agent session: the text of `instructions.md` as a system-prompt append, and `plugin/` as a local Claude Code plugin. The kernel passes both to the agent backend through `AgentSessionOptions`; the claude-code adapter turns them into `query()` options.

## Interface

```
src/shared/plugin/api.ts
  MetaRepoKey ('metaRepo')

src/host/session/agent-backend.ts                                   (kernel)
  interface SessionAdditions {
    systemPromptAppend: string             '' adds nothing
    pluginPaths: ReadonlyArray<string>     absolute paths of local Claude Code plugins
  }
  interface AgentSessionOptions extends SessionAdditions { config, resume, emit, tools }

src/host/services/meta-repo-seam.ts                                 (kernel)
  interface MetaRepo { forNewSession: Effect<SessionAdditions> }    provided under MetaRepoKey
  resolveSessionAdditions(registry: Pick<PluginRegistry, 'inject'>): Effect<SessionAdditions>
    never fails; no provider, an invalid value or a defect in forNewSession gives
    { systemPromptAppend: '', pluginPaths: [] }

src/host/plugin-api.ts
  re-exports MetaRepoKey, MetaRepo, SessionAdditions

plugins/meta/
  plugin.json   { name: 'meta', category: 'feature', host: 'host.ts', load: 'eager' }
  host.ts       ensures the repo at <dataDir>/repo, provides MetaRepoKey
  meta-repo.ts  ensureMetaRepo(directory), makeMetaRepo(directory): MetaRepo

plugins/claude-code/session-additions.ts
  sessionAdditionsOptions(additions): Pick<Options, 'systemPrompt' | 'plugins'>
```

## Behaviour

- The repo lives at `<userData>/plugins/meta/repo` (the plugin's `dataDir`, ADR-0032):

  ```
  repo/
    instructions.md                      empty when created
    plugin/.claude-plugin/plugin.json    { "name": "dia-meta", "description": ... }
  ```

- `ensureMetaRepo` writes each of the two files only when it is missing, so it never overwrites a user's or meta agent's edit. When `repo/.git` is missing or the repo has no commit (`git rev-parse --verify HEAD` fails) it runs `git init`, then `git add -A` and `git commit` with the committer identity `dia <dia@localhost>` passed through `-c`, so the first commit does not depend on the user's git config; it also passes `commit.gpgsign=false` and `--no-verify`, so a signing prompt or a global hook cannot block the plugin's eager setup, which the Host waits for before it reports ready. A failed git command is logged as a warning and does not fail the plugin: agents still receive the files.
- `forNewSession` reads `instructions.md` from disk on every call and trims it; a read failure logs a warning and gives an empty append. `pluginPaths` is `[<repo>/plugin]`. Reading on every call is what makes a change merged into the repo apply to agents started afterwards.
- `SessionFactoryLive` calls `resolveSessionAdditions` on every session start and spreads the result into `openSession`'s options.
- The adapter always sets `systemPrompt: { type: 'preset', preset: 'claude_code' }`, adding `append` when `systemPromptAppend` is not empty, and sets `plugins: [{ type: 'local', path }]` per plugin path when there is at least one. `settingSources` stays unset (the SDK default). The options are computed once per `openSession` and reused by every restart of that session (thinking-level change, rewind), so a running agent keeps what it started with.
- A session resumed after an app restart gets the current `plugin/`, but the SDK records the system prompt on a conversation's first request and reuses it on resume (`snapshot` default), so its append stays the one it started with.

## Design Rationale

**A feature plugin, not kernel code** — ADR-0019 makes every replaceable feature a plugin and the issue scopes this step as a Host built-in feature plugin. Unloading `meta` leaves agents on the plain preset.

**Generic session fields** — `systemPromptAppend` and `pluginPaths` name what the adapter does with them, not where they come from. Org step 1 (#40) appends role instructions to the same field.

**The kernel sees `SessionAdditions`, not files** — the seam exposes only what a session receives (Information Hiding). Where the repo lives and which files it reads stay inside the plugin, so later steps can change the layout without touching the kernel.

**Always the `claude_code` preset** — without `systemPrompt` the SDK uses a minimal prompt that omits Claude Code's tool guidance and safety instructions (`docs/reasoning/2026-11-01-sdk-default-system-prompt-is-minimal.md`). ADR-0025 gives every agent the preset, and ADR-0037 runs the user's own Claude Code, so the preset applies whether or not `meta` is loaded.

**The repo under the plugin's `dataDir`** — ADR-0032 gives each plugin a data directory under `userData` that survives reloads and restarts. ADR-0025 places the repo under `userData`; `dataDir` satisfies that without a new plugin-context field.

## Rejected Alternatives

**A kernel `MetaRepo` service** — fewer files, but contradicts the issue's scope and ADR-0019; the meta repo could not be unloaded or overridden.

**`<userData>/meta` exactly as drawn in ADR-0025** — needs `userData` in the plugin context, a plugin API change for one path.

**Creating empty `skills/`, `agents/`, `hooks/`, `commands/`** — git does not track empty directories and Claude Code finds them when they appear.

**Preset only when an append exists** — leaves agents without instructions on the minimal prompt, against ADR-0025's "every agent".

## Refinement Record

Rounds ran inline (no subagents in this run), effort medium; round 2 raised no blocker or major finding, so the rounds stopped.

**Applied**
- *Information Hiding* (round 1, major) — the first draft gave the kernel `MetaRepo { instructionsPath, pluginPath }`; the kernel would have read files it does not own. Now `forNewSession` returns `SessionAdditions`.
- *Correctness* (round 1, major) — the first draft read `instructions.md` once at plugin setup, so a merged change would apply only after a reload. Now it is read on every session start.
- *Correctness* (round 1, minor) — options are computed once per `openSession`, so a thinking-level restart does not pick up a newer append mid-agent.

**Rejected**
- *Define Errors Out of Existence* (round 1, minor) — `systemPromptAppend: string` admits `''`; an `Option` was proposed. Rejected: the adapter treats `''` as no append, the plugin trims, and an empty append is not an invalid state.
- *Strategic Programming* (round 2, minor) — `MetaRepoKey` names one provider, so a second feature cannot add a plugin path. Rejected: org step 1 supplies role instructions from the session's role, not through a service key, and the plugin registry allows one provider per key by design.

**Escalated**
- None. Gate decisions were taken autonomously (no user in this run) and are listed in the PR.

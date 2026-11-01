# Project agent import

Issue: #96. Related: ADR-0023, ADR-0046, #94 (`docs/designs/workspace-store.md`), #95. Scope: module (one optional `AgentBackend` capability, its claude-code implementation, and the Host's use of it in `registerProject`).

## Name and Purpose

Adding a project imports the conversations each loaded agent adapter already holds for that directory: every discovered session becomes a tab (an `agents` row with its current `agent_sessions` row), which resumes when the user shows it.

## Decisions

The issue left four questions open; no user was available, so each was decided here against `PRODUCT.md`, ADR-0023, ADR-0046 and the Agent SDK 0.3.311 reference.

| Question | Options considered | Choice | Reason |
| --- | --- | --- | --- |
| 1. Grouping sessions into agents | one agent per session; chain sessions by `/clear` and fork lineage | One agent per session | The SDK exposes no lineage: `SDKSessionInfo` (`sdk.d.ts`) has `sessionId`, `summary`, `lastModified`, `fileSize`, `customTitle`, `firstPrompt`, `gitBranch`, `cwd`, `tag`, `createdAt` and nothing naming a parent. A session forked with `claude -p --resume <id> --fork-session` contains no reference to its source id (probe below), and `/clear` starts an unlinked session (`docs/reasoning/2026-10-31-agent-sessions-clear-and-removal-race.md`). Grouping by comparing message content would be a guess. Consequence: an agent that ran `/clear` or rewound returns as several agents; the newest holds the conversation it last resumed. |
| 2. Name, model, thinking level, permission mode | the harness's title or a generated name; the user's new-agent defaults or fixed safe defaults; the model the transcript last used | Name: the harness's title for the session (`customTitle`, else `summary`), trimmed and cut to 64 characters; a generated name when that is empty. Model: the adapter's choice, `default` for claude-code (the model `claude` uses with no `--model`, and the first row of its model list). Thinking level `medium` (`DEFAULT_THINKING_LEVEL`). Permission mode `default` (`DEFAULT_PERMISSION_MODE`) | The title is what Claude Code's own `/resume` shows, so the user recognises the conversation. The model value belongs to the adapter, so the adapter names it. An imported conversation never gets a wider permission mode than `default` without the user choosing it; the user's defaults may be `bypassPermissions`. `SDKSessionInfo` carries no model, and reading every transcript for its last model costs a full read per session. |
| 3. Sessions started outside dia (CLI) | import them; offer them in a picker | Import them, like dia's own | dia cannot tell its sessions from CLI sessions: both are written by Claude Code, and the probe's `claude -p` sessions recorded `entrypoint: "sdk-ts"`, the value dia's own sessions record. The import runs only on the user's Add project action and every imported agent is listed in the overview at once, so nothing appears without the user's action. A picker needs a dialog and two RPCs; it can replace this when projects with many sessions make it necessary. |
| 4. Rescan for a registered project | a Rescan action; import only on add | Import only when a project is registered | A rescan would bring back the superseded sessions of live agents as new agents unless it compared against every `agent_sessions` row, which `WorkspaceStore` does not expose. Removing and adding a project again is the rescan for now. |
| Imported agents archived or active | archived (PR #129); active and cold | Active, cold (no session started) | An archived tab never runs and dia has no unarchive (`Tab` JSDoc, `src/shared/domain/project.ts`), so an archived import could never resume. A cold tab starts no process until it is shown (`makePaneWorkspaceLive` JSDoc). |
| Sessions of other worktrees | `listSessions` default `includeWorktrees: true`; `false` | `false`; also drop a session whose `cwd` names another directory | Claude Code finds a transcript by the session's working directory (`docs/reasoning/2026-07-17-worktree-reattach-resume-incantation.md`), so a session from another worktree resumed in the project directory is not found. The project-key encoding is lossy (`F:\Dev\.scratch\dia-96\exp` → `F--Dev--scratch-dia-96-exp`), so `cwd` is compared too. |

## Probe (Agent SDK 0.3.311, Claude Code 2.1.316)

In `F:\Dev\.scratch\dia-96\exp`: `claude -p "Remember the word PELICAN. Reply only OK."`, then `claude -p --resume <id> --fork-session "Reply only OK2."`. `listSessions({ dir })` returned both sessions, newest first, each with `cwd: "F:\\Dev\\.scratch\\dia-96\\exp"`, `summary` and `customTitle` `"Remember word PELICAN"`, `createdAt` and `lastModified`. `listSessions({ dir, includeProgrammatic: false })` returned none, so the call must keep the default `includeProgrammatic: true`. The forked transcript contains no occurrence of the source session id.

## Interface

```ts
// src/host/session/agent-backend.ts

/**
 * A conversation an agent harness holds, as {@link AgentBackend.discoverSessions} reports it.
 * `title` is the harness's name for it (may be empty); `startedAt` is when it began, in epoch ms;
 * `model` is the model value a session resuming it is opened with.
 */
export interface DiscoveredSession {
  readonly sessionId: SessionId
  readonly title: string
  readonly startedAt: number
  readonly model: string
}

export interface AgentBackend {
  // ...existing members...
  /**
   * Optional. The conversations the harness holds whose working directory is `directory`, in any
   * order. Never fails: empty when there are none or they cannot be read. An adapter without it
   * imports nothing when a project is added.
   */
  readonly discoverSessions?: (directory: string) => Effect.Effect<ReadonlyArray<DiscoveredSession>>
}
```

`agentBackendProblems` reports `"agentBackend.discoverSessions" is not a function` when the member is present and is not a function. `plugin-api.ts` exports the `DiscoveredSession` type. `PLUGIN_API_VERSION` and every `plugins/*/plugin.json` go from `0.0.14` to `0.0.15`. `PROTOCOL_VERSION` is unchanged: no RPC or event shape changes.

```ts
// src/host/services/transcript-reader.ts — TranscriptReader gains:
/**
 * The conversations the loaded agent adapter holds for `directory`. Empty, with a log line, when
 * no adapter is loaded or it cannot discover sessions. Never fails.
 */
readonly discoverSessions: (directory: string) => Effect.Effect<ReadonlyArray<DiscoveredSession>>
```

```ts
// src/shared/domain/agent-name.ts
/** The agent name for a harness's conversation title: trimmed, cut to 64 characters. `None` when nothing is left. */
export const agentNameFromTitle: (title: string) => Option.Option<AgentName>
```

```ts
// src/shared/domain/workspace.ts — addProject gains a tabs argument
/**
 * Registers `project` with `tabs` at the end of the project order. A tab whose `sessionId`
 * another tab already holds is left out. Succeeds unchanged when ... (as before).
 */
export const addProject: (workspace: Workspace, project: Project, tabs?: ReadonlyArray<Tab>) => Result<Workspace, ProjectAlreadyRegisteredError>
```

`PaneWorkspace.registerProject` keeps its signature; its JSDoc adds: "Imports the conversations the agent adapter holds for the directory as tabs that have not started, in the order they began. The visible tab does not change."

## Internal Decomposition

- **`plugins/claude-code/discovery.ts`** (new) — `discoverSessions(directory)`: `listSessions({ dir: directory, includeWorktrees: false })`, a rejection logged as a warning and treated as no sessions; then the pure `toDiscoveredSessions(infos, directory)`, which drops a session whose `cwd` is set and differs from `directory` (compared with `path.relative(...) === ''`, case-insensitive on Windows), and maps `title = customTitle ?? summary`, `startedAt = createdAt ?? lastModified`, `model = 'default'`. Logs the count at debug. `backend.ts` adds `discoverSessions`.
- **`TranscriptReaderLive`** — resolves the backend per call, as `readHistory` does; calls `discoverSessions` when present, else logs at debug and returns `[]`.
- **`registerProject`** (`pane-workspace.ts`) — after the directory check and `probeProject`, calls `transcriptReader.discoverSessions(project.directory)`, sorts by `startedAt`, and builds a `Tab` per session: a pane id from `Crypto.randomUUIDv4`, `name` from `agentNameFromTitle` or `generateAgentName`, `config = { paneId, cwd: project.directory, model, thinkingLevel: DEFAULT_THINKING_LEVEL, permissionMode: DEFAULT_PERMISSION_MODE }`, the `sessionId`, `archived: false`. Then `mutate('registerProject', ws => addProject(ws, project, tabs))`. Logs `Registered project` with the imported count. `makePaneWorkspaceLive` requires `Crypto`; `host-main.ts` provides `NodeServices.layer` (which includes `FileSystem`, `Path` and `Crypto`) in place of `NodeFileSystem.layer` and `NodePath.layer` for that layer.
- **`WorkspaceStore`** — unchanged: each imported tab's `sessionId` is stored as its current `agent_sessions` row by the existing diff save.

## Verification

Tests:

1. `agent-name.test.ts` — `agentNameFromTitle` trims, cuts to 64 characters (and trims again), and gives `None` for a blank title.
2. `workspace.test.ts` — `addProject` with tabs adds them in order; a tab whose `sessionId` another project's tab holds is left out; the visible tab is unchanged.
3. `transcript-reader.test.ts` — discovers through the backend; a backend without `discoverSessions` and no backend both give `[]`.
4. `agent-backend.test.ts` — a non-function `discoverSessions` is a problem; an absent one is not.
5. `pane-workspace.test.ts` — `registerProject` imports discovered sessions as tabs in `startedAt` order with the session ids, titles, `cwd` = the project directory, the adapter's model and the safe defaults; starts no session; leaves the visible tab; with no discovered sessions the project has no tabs.
6. `plugins/claude-code/discovery.test.ts` — `toDiscoveredSessions` maps title and start time with their fallbacks and drops a session of another `cwd`.

In the app (`verify-in-app`, packaged build): a project with one dia agent that has a conversation is removed and added again; its agent returns and, shown, resumes the conversation (a reply that uses earlier context). A `claude -p` session started in the project directory appears as an agent after the add and resumes.

## Not covered

- Agents that ran in a dia worktree: their sessions are recorded under the worktree path, which removal deletes (#95), so they are not discovered.
- The model, thinking level and permission mode an agent had before removal: `host.db` rows are deleted on removal (ADR-0046) and `SDKSessionInfo` does not carry them.
- A Rescan action and a picker (questions 3 and 4).

## Rejected Alternatives

- **Keep a removed project's `agents` and `agent_sessions` rows to regroup sessions on re-add** — contradicts ADR-0046 ("deletes the project's `host.db` rows").
- **Write dia's agent id into each session with `tagSession`** — writes to harness data the user sees in `/resume`; ADR-0046 limits dia to what it created.
- **Import as archived** — see Decisions.

## Refinement Record

Rounds ran inline (the run may start no subagents other than the PR review passes).

**Round 1 — Applied**
- *Correctness* — `includeProgrammatic: false` would drop every dia session; the spec states that the default is kept (probe).
- *Correctness* — a session from another worktree would resume in the wrong directory and not be found; `includeWorktrees: false` plus the `cwd` check.
- *Correctness* — `WorkspaceStore.save` fails when two tabs share a `sessionId`; `addProject` leaves out a tab whose session another tab holds.
- *Information Hiding* — the Host receives `DiscoveredSession` and never names `listSessions` or `SDKSessionInfo`; the model value comes from the adapter.
- *Define Errors Out of Existence* — a title that is not a valid `AgentName` cannot reach `Tab`: `agentNameFromTitle` returns `None` and a generated name is used.

**Round 1 — Rejected**
- *Strategic Programming* — proposed a `registerProject(…, { import: boolean })` flag for a future picker. Rejected: no caller needs it now.

**Round 2** — no blocker or major finding. Minor, applied: `startedAt` falls back to `lastModified`, since `createdAt` is optional in `SDKSessionInfo`.

**Escalated** — none.

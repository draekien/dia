# dia MVP — Technical Specification

Implements: [`docs/prds/mvp.md`](../prds/mvp.md)
Builds on: [ADR-0003](../adr/0003-agent-sdk-runs-in-electron-utility-process.md), [ADR-0007](../adr/0007-one-utility-process-per-pane.md), [ADR-0008](../adr/0008-local-file-persistence-for-session-and-layout-state.md), [ADR-0009](../adr/0009-effect-ts-for-main-process-orchestration.md)

## 1. Overview

The MVP adds split-pane, parallel agent sessions to dia. Each pane owns an independent Agent SDK session running in its own `utilityProcess`. Main-process orchestration (process lifecycle, IPC routing, attention state, persistence) is built on Effect TS; the renderer stays plain React (ADR-0002) and only consumes a typed IPC contract.

This document covers the main-process domain model and services needed to satisfy the PRD's goals and user stories. It does not cover renderer component structure, styling, or pane-resize interaction mechanics — those are implementation detail for the build itself, not architecture.

## 2. Architecture Overview

```
Renderer (React)
   │  IPC (Schema-validated commands / events)
   ▼
Main process (Effect runtime)
   ├── PaneTreeService     — layout tree: split/close/resize/serialize
   ├── PaneSupervisor       — one Fiber + Scope per pane, owns its utilityProcess
   ├── GitOpsService       — git CLI operations (starting with worktree create/remove)
   ├── PersistenceService  — read/write layout + session state as local JSON
   └── IpcGateway           — validates/encodes messages to/from the renderer
         │
         ▼  (per pane)
   utilityProcess
   └── AgentSession — wraps one Agent SDK query loop for that pane
```

One `PaneSupervisor`-managed `Fiber` exists per open pane. Closing a pane closes its `Scope`, which tears down its `utilityProcess` and unsubscribes its IPC routing — no pane's cleanup can leak into another's.

## 3. Domain Model

```ts
type PaneId = string // uuid

type PaneNode =
  | { _tag: "Split"; direction: "row" | "column"; children: ReadonlyArray<PaneNode>; sizes: ReadonlyArray<number> }
  | { _tag: "Leaf"; paneId: PaneId }

type AttentionState =
  | { _tag: "Idle" }
  | { _tag: "AwaitingPermission"; request: PermissionRequest }
  | { _tag: "Errored"; error: PaneError }
  | { _tag: "Completed" }

type WorktreeInfo = {
  path: string        // the worktree's own directory; used as the pane's effective cwd
  branch: string      // branch created for the worktree
  sourceRepo: string  // the repo directory the worktree was created from
}

type PaneConfig = {
  paneId: PaneId
  cwd: string           // effective working directory: worktree.path when worktree is set, else sourceRepo
  model: string
  worktree?: WorktreeInfo
}

type PaneRecord = {
  config: PaneConfig
  history: ReadonlyArray<ConversationMessage>
  attention: AttentionState
}
```

All of the above are defined as `Schema` types (`@effect/schema`), giving one definition that covers runtime validation, IPC encode/decode, and JSON persistence encode/decode — no separate DTO layer.

`AttentionState` transitions are pure (`Idle → AwaitingPermission → Idle`, `Idle → Errored`, `Idle → Completed → Idle`) and drive the pulse color directly: amber for `AwaitingPermission`, red for `Errored`, green for `Completed`.

## 4. Components

### 4.1 PaneTreeService

Holds the current `PaneNode` tree in a `Ref<PaneNode>`. Operations (`split`, `close`, `resize`) are pure tree transforms wrapped in `Effect`, each followed by a call to `PersistenceService.saveLayout`. Closing a `Leaf` also signals `PaneSupervisor` to tear down that pane's `Scope`.

### 4.2 PaneSupervisor

For each pane, `PaneSupervisor` runs a scoped `Effect` that:

0. If the pane was created with the worktree toggle on, calls `GitOpsService.createWorktree` (`Effect.acquireRelease`, so the worktree's removal is guaranteed on scope close, including on error) and uses the resulting `WorktreeInfo.path` as the pane's effective `cwd`; otherwise uses the chosen directory directly.
1. Spawns the pane's `utilityProcess` (`Effect.acquireRelease`, so process teardown is guaranteed on scope close, including on error).
2. Starts an `AgentSession` inside that process, configured with the pane's `cwd` and `model`.
3. Forks a `Fiber` that consumes the process's message stream (a `Queue`/`Stream`) and updates that pane's `AttentionState` and `history` in a `Ref<PaneRecord>`.
4. Publishes attention-state changes and new messages to `IpcGateway` for that pane's channel.

A crash in one pane's `utilityProcess` is caught as a typed `ProcessCrashedError`, transitions that pane to `Errored`, and does not affect any other pane's `Fiber` or `Scope` — this is the isolation guarantee ADR-0007 exists for. The worktree `acquireRelease` (step 0) is independent of the process's: a process crash tears down and re-raises through the process's own release without touching the worktree, and closing the pane always runs the worktree's release, so a pane's worktree is removed exactly once, on pane close, regardless of how the process fared.

### 4.3 AgentSession (runs inside the utilityProcess)

Thin wrapper around the Agent SDK's session loop for one pane: sends user messages in, emits assistant messages/tool-permission-requests/errors/completion out over the process's IPC channel to main. Permission responses (approve/deny) from the user flow back in the same direction.

### 4.4 PersistenceService

Wraps `@effect/platform-node`'s `FileSystem` to read/write two JSON documents under Electron's `userData` directory: the pane layout tree, and a per-pane conversation history file. Reads/writes are encoded/decoded through the `Schema` types in §3, so a malformed file on disk surfaces as a typed `PersistenceDecodeError` rather than a runtime crash — recovered by falling back to an empty default layout.

### 4.5 IpcGateway

Defines the full command/event contract as `Schema`-validated messages:

- **Commands** (renderer → main): `ChooseDirectory`, `CreatePane` (`cwd`, `model`, `useWorktree`), `SplitPane`, `ClosePane`, `SendMessage`, `ResolvePermission`, `FocusPane`
- **Events** (main → renderer): `LayoutChanged`, `PaneMessageAppended`, `PaneAttentionChanged`, `PaneClosed`, `PaneCreateFailed`

Every message is decoded with its `Schema` on receipt; a decode failure is a typed error logged and dropped, never an uncaught exception crossing the IPC boundary.

`ChooseDirectory` opens the OS-native directory picker (Electron's `dialog.showOpenDialog`, main-process only — nothing renderer-side reaches the filesystem directly) and returns `{ path, isGitRepo }` (a `.git` presence check alongside the chosen path, so the renderer can render the worktree toggle without a second round-trip), which the renderer then passes into `CreatePane` along with the worktree toggle's value. `PaneCreateFailed` surfaces a `CreatePane` failure (worktree or process spawn) back to the still-pending pane.

### 4.6 GitOpsService

Wraps git CLI invocations (via `@effect/platform`'s `Command` executor). Named generally rather than after its first use, since further git operations beyond worktree management are expected to join this service in later bullets:

- `createWorktree(sourceRepo: string, paneId: PaneId): Effect<WorktreeInfo, WorktreeCreateError>` — runs `git worktree add` for a new branch under a dia-managed directory (Electron's `userData/worktrees/<paneId>`), returning the resulting `WorktreeInfo`.
- `removeWorktree(info: WorktreeInfo): Effect<void, WorktreeRemoveError>` — runs `git worktree remove --force` for that pane's worktree.

`createWorktree` is only invoked when the pane's chosen directory is a git repository and the user opted into a worktree at pane-creation time; `removeWorktree` runs as the release side of the `Effect.acquireRelease` in `PaneSupervisor` §4.2 step 0, so it always runs once when the pane's `Scope` closes.

## 5. Concurrency Model

Each pane's lifecycle (process + IPC subscription + state) lives in one `Scope`, run as one `Fiber` under a single `Effect.forkScoped` per pane, all supervised by the main process's `ManagedRuntime`. Up to 6 such fibers run concurrently per the PRD's scale goal. There is no shared mutable state across panes — each pane's `Ref<PaneRecord>` is independent — so no cross-pane locking is needed.

## 6. Error Handling

All domain failures are typed tagged errors (`ProcessSpawnError`, `ProcessCrashedError`, `PersistenceReadError`, `PersistenceDecodeError`, `AgentSessionError`, `WorktreeCreateError`, `WorktreeRemoveError`), not thrown exceptions. Each is handled at the boundary that owns recovery:

- `ProcessSpawnError` / `ProcessCrashedError` → that pane's `AttentionState` becomes `Errored` (red pulse); other panes are unaffected.
- `PersistenceReadError` / `PersistenceDecodeError` on startup → fall back to an empty default layout rather than failing app launch.
- `AgentSessionError` (e.g. Agent SDK reports a failure mid-turn) → surfaces to that pane as `Errored`.
- `WorktreeCreateError` → pane creation fails with an error shown to the user before any process is spawned; nothing partially created to clean up.
- `WorktreeRemoveError` on pane close (e.g. the worktree has uncommitted changes `git worktree remove` refuses to discard) → logged, not surfaced as a blocking dialog; per the PRD, worktree removal on close is unconditional and best-effort, not gated on a user confirmation.

## 7. Testing Strategy

Consistent with the PRD's "automated + manual" decision:

- **Automated**: `PaneTreeService` tree operations (split/close/resize) as pure unit tests; `AttentionState` transition logic; `PersistenceService` encode/decode round-trips including malformed-file fallback; `GitOpsService` create/remove-worktree against a test `Layer` in place of the real git `Command` executor, including the remove-failure-is-logged-not-thrown path; simulated pane crash/recovery using Effect's `TestClock`/test `Layer`s in place of a real `utilityProcess`.
- **Manual**: pane splitting/resizing by hand, the focus/expand interaction, choosing a working directory via the native picker and toggling worktree creation, confirming a closed pane's worktree is actually removed on disk, and the full permission-request → pulse → focus → approve/deny flow against real local Claude Code sessions, including dogfooding on dia's own repository.

## 8. Non-Goals

Mirrors the PRD's Out of Scope, plus technical exclusions specific to this spec:

- No renderer-side Effect TS usage — renderer consumes the IPC contract via plain React/TypeScript.
- No cross-pane shared state or locking mechanism (each pane is fully independent, per ADR-0007).
- No database or query layer over persisted state (per ADR-0008).
- No dynamic reconfiguration of a running pane's `cwd`, `model`, or worktree — changing any of these requires closing and reopening the pane.
- No worktree creation for a `cwd` that isn't a git repository — `GitOpsService.createWorktree` is simply not invoked, no fallback or detection UI.
- No confirmation dialog or dirty-worktree check before `GitOpsService.removeWorktree` runs on pane close.
- No merge/rebase tooling for reconciling a worktree's branch — out of scope per the PRD; the user does this with their own git tooling.

## 9. Open Questions

- Exact on-disk layout for per-pane history files (one file per pane vs. one combined file) — affects write granularity but not the `Schema`/service boundary above; can be decided during implementation.

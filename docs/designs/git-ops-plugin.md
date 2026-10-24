# Git operations plugin

Status: partly superseded (ADR-0029). `docs/designs/adapter-category.md` deleted `ESSENTIAL_PLUGINS`, so the plugin is a feature that can be unloaded and overridden. It was then renamed `plugins/worktrees`: the plugin provides its `GitOps` value directly (no factory) under the service key `worktrees` (`WORKTREES_KEY` in `src/shared/plugin/api.ts`), and `resolveGitOps` returns `Option<GitOps>`. The pane creation form enables worktrees when some plugin's `PluginInfo.provides` lists `WORKTREES_KEY` (`PROTOCOL_VERSION` 7). While no plugin provides it, a new pane that asks for a worktree opens in the project directory, the pane creation form disables its worktree switch with `Load the worktrees plugin to use worktrees`, and resuming a pane that has a worktree fails with `WorktreeReattachError` (`Load the worktrees plugin to resume this pane`) and leaves the worktree on disk. The rest of this document describes the plugin as first built.

## Purpose

The git operations behind a pane's worktree (`createWorktree`, `removeWorktree`, `reattachWorktree`) and the worktree name generator become the built-in plugin `git-ops`. The kernel keeps the pane lifecycle in `PaneSupervisor` and resolves the operations by service key each time a pane opens. `git-ops` is essential (ADR-0028): `removeWorktree` runs at pane teardown, so the plugin cannot be unloaded or replaced while worktree panes can exist.

## Interface

```
src/host/services/git-ops-seam.ts                         (kernel)
  GIT_OPS_KEY = 'gitOps'                                  value: () => GitOps
  interface GitOps { createWorktree, removeWorktree, reattachWorktree }   (context-free Effects)
  class WorktreeCreateError, WorktreeRemoveError, WorktreeReattachError   (moved from git-ops-service.ts)
  resolveGitOps(registry: Pick<PluginRegistry, 'inject'>): Effect<GitOps>   never fails

plugins/git-ops/
  plugin.json   { name: 'git-ops', api: '1', host: 'host.ts', load: 'eager' }
  host.ts       builds makeGitOps with NodeServices and provides GIT_OPS_KEY
  git-ops.ts, worktree-slug.ts, and their tests            (moved from src/host/services)

src/host/plugin-api.ts
  re-exports GIT_OPS_KEY, GitOps, GitOpsFactory and the three error classes
```

## Behaviour

- `PaneSupervisorLive` requires `HostPlugins` instead of `GitOpsService`. `openPane` calls `resolveGitOps` only for a pane that asks for a worktree.
- When the plugin is not loaded, provides a non-function, or its factory throws, `resolveGitOps` logs and returns an inert `GitOps`: `createWorktree` fails with `WorktreeCreateError` and `reattachWorktree` with `WorktreeReattachError` (cause `The git-ops plugin is not loaded`), so no pane runs in the source repository when a worktree was requested; `removeWorktree` logs a warning and succeeds, leaving the directory on disk.
- A reload of `git-ops` applies from the next `openPane`; a running pane keeps the `GitOps` it resolved, and its teardown uses that value.
- `ESSENTIAL_PLUGINS` is `['permissions', 'thinking', 'git-ops']`.
- `PluginInfo` and `DiaRpcs` are unchanged, so `PROTOCOL_VERSION` stays 5.
- The plugin imports `@effect/platform-node/NodeServices`, not the package index (`docs/reasoning/2026-10-24-plugin-import-platform-node-subpath.md`).

## Constraints

- The error classes live in the kernel and the plugin imports them through `@dia/plugin`, so the supervisor and `PaneWorkspace` keep one error type for both the plugin's and the inert implementation.
- The plugin holds 34.5 MB of tracked memory at load (the Node platform services), measured by the plugin memory guard in the unpackaged app.

## Refinement record

No separate critique rounds were run: the design copies the `session-reducer`, `permissions` and `thinking` seams. The user approved the design, including that `git-ops` is essential and that an unavailable plugin refuses worktree panes.

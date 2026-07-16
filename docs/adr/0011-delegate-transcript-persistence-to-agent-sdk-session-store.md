---
status: "accepted"
date: 2026-07-16
decision-makers: William Pei
---

# Delegate conversation-transcript persistence to the Agent SDK session store

## Context and Problem Statement

ADR-0008 decided dia would persist "a pane tree (layout) plus, per pane, a linear
conversation history" as local JSON arrays. While scoping Bullet 05 (Persistence &
Restart Restore) we found the Agent SDK already persists each session's full transcript —
every prompt, tool call, tool result, and response — to disk automatically at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, and exposes `resume`,
`listSessions()`, and `getSessionMessages()` to resume or read it back. Given that, should
dia keep hand-rolling its own per-pane conversation-history JSON, or delegate the
transcript to the SDK and persist only what it needs to find and resume each session?

## Decision Drivers

* Zero data loss across restart (G-3) — the transcript must be durable and complete,
  including user messages (dia's own in-memory history currently records assistant
  messages only).
* Simplicity first — avoid maintaining a second copy of the transcript that can drift
  from the SDK's source of truth.
* The user chose **live SDK resume, lazily on pane focus**: a restored pane must be able
  to hand its prior context back to Claude, not merely re-display old text.
* dia must still restore the layout tree and enough per-pane metadata to resume.

## Considered Options

* Delegate the transcript to the SDK session store; dia persists only the layout tree and
  a per-pane index (`config` + `sessionId`).
* Dual-write: dia persists its own per-pane conversation-history JSON (as ADR-0008
  described) *and* captures `sessionId` for resume.

## Decision Outcome

Chosen option: "Delegate the transcript to the SDK session store", because the SDK is
already the durable, complete source of truth for the conversation (it captures user and
assistant messages plus tool activity, which dia's in-memory history does not), and
live resume requires a `sessionId` keyed to that store regardless — so a second dia-owned
copy of the transcript would be redundant state that can only drift from what Claude
actually resumes with.

dia persists a single atomic `workspace.json` under `app.getPath('userData')`:

```
{ tree: PaneNode, panes: Record<PaneId, { config: PaneConfig, sessionId?: string }> }
```

On launch, dia rebuilds the tree and renders each pane's transcript via
`getSessionMessages()` (no process spawn). On first focus of a restored (cold) pane, dia
spawns its process with `resume: sessionId`.

This supersedes ADR-0008: the layout-as-local-JSON decision stands, but the persisted
shape no longer includes per-pane message arrays.

### Consequences

* Good, because there is one source of truth for the transcript (the SDK store), so
  what a pane re-displays is exactly what Claude resumes with — no drift.
* Good, because user messages and tool activity are captured for free; dia no longer has
  to fix its assistant-only in-memory history to meet the zero-data-loss goal.
* Good, because dia's persisted file stays small (tree + resume keys), keeping full-file
  read/write cheap despite ADR-0008's noted downside.
* Bad, because restore now couples to the SDK's on-disk layout: sessions are keyed by
  `<encoded-cwd>`, so a pane's `cwd` must be reconstructable at the exact original path
  for `resume` to find its transcript. This is the crux of worktree-pane restore (see
  More Information).
* Bad, because rendering a restored pane before focus depends on `getSessionMessages()`
  reading `~/.claude` transcripts from the main process; if that internally shells out
  rather than reading the JSONL in-process, startup cost/behavior must be re-evaluated.
* Bad, because dia does not control transcript retention — the SDK's `cleanupPeriodDays`
  can sweep a session file out from under a persisted `sessionId`, which must be handled
  as a missing-session fallback.

## Pros and Cons of the Options

### Delegate to the SDK session store

* Good, because it removes an entire persistence path (per-pane history JSON) and its
  drift risk.
* Good, because it captures the complete transcript (user + assistant + tools).
* Bad, because it binds restore to the SDK's cwd-keyed on-disk format and retention.

### Dual-write (dia keeps its own history JSON)

* Good, because dia's transcript is self-contained and decoupled from `~/.claude`
  internals, giving a fully in-repo round-trip test.
* Bad, because it maintains two copies of the same conversation that can diverge, and the
  copy dia shows may not match what Claude actually resumes with.
* Bad, because it still requires capturing `sessionId` for resume anyway, so the extra
  history JSON buys decoupling at the cost of redundancy.

## More Information

Evidence from a worktree-reattach spike (git 2.47.1.windows.2), which matters because
worktree panes are the case where `cwd` must be reconstructed for the SDK's cwd-keyed
lookup to succeed:

* Worktree panes' `cwd` is `<userData>/worktrees/<paneId>` — deterministic from `paneId`,
  so the path is stable across restarts.
* Worktrees are removed on graceful shutdown, but their branch (`dia/<paneId>`) persists.
* `GitOpsService.createWorktree`'s current incantation `git worktree add <path> -b
  dia/<paneId>` **fails on resume**: `fatal: a branch named 'dia/pane-123' already
  exists`.
* **Reattach** with `git worktree add <path> dia/<paneId>` (no `-b`) succeeds and restores
  the branch's committed work intact. This is the resume incantation.
* **`-B` must not be used**: `git worktree add -B <branch> <path>` force-resets the branch
  to HEAD and **discards the pane's committed work**.
* Reattach must be guarded: re-adding when the worktree dir already exists fails, so
  resume must be a no-op when the pane already has a live handle. On an ungraceful crash
  the worktree dir may survive but be unregistered — `git worktree prune` before reattach
  may be needed (untested).

Follow-up: revisit if a future feature needs cross-session search (ADR-0008's original
caveat still applies to the layout/index file).

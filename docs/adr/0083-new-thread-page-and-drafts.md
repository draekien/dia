---
status: "accepted"
date: 2026-11-15
decision-makers: William Pei
---

# One new-thread page for every target, with drafts kept in the renderer

## Context and Problem Statement

Starting a thread took three screens: a first-run screen with no projects, a "No thread is open" screen, and a per-project New agent form with a Name field and a worktree switch. The form created an empty tab, and the first message was typed into that tab's composer. The Assistant (ADR-0081) was started from its own page. The user wants one page that opens on Send-ready composer text, picks the project or other target in its headline, and keeps unsent text until it is sent or discarded.

## Decision Drivers

* One entry point and one page for every place a thread can start: a project, or a plugin such as the Assistant.
* Unsent text survives switching tabs and restarting dia.
* The first message is sent by the Host with the tab creation, because the page unmounts as soon as the new tab becomes visible.
* The workspace choice (checkout branch, or a worktree from a base branch) is made on the page, before the tab exists.

## Considered Options

* Drafts in renderer `localStorage`; plugin targets through a chat-owned `ThreadTargetsSlot` list.
* Drafts in the Host database, sent over `DiaRpcs`.
* Keep the New agent form and add an Assistant option to it.

## Decision Outcome

Chosen option: "Drafts in renderer `localStorage`; plugin targets through a chat-owned `ThreadTargetsSlot` list", because a draft is renderer state that no other process reads, and the slot lets any plugin offer a target without the kernel knowing it.

* **View.** `NewThreadView{draftId}` (`src/renderer/src/lib/view.ts`) replaces `NewAgentView`, `FirstRunView` and `EmptyProjectView`. With no tab, page or draft open, the view is `NewThreadView` of `FALLBACK_DRAFT_ID`, one id per renderer session. The `dia-chat` plugin draws the page (`plugins/dia-chat/new-thread-page.tsx`) in the `main.tab` slot.
* **Drafts.** `Draft` (`src/renderer/src/lib/drafts.ts`) holds the target, text, model, thinking level, permission mode, worktree choice and `sentAs`. `draftsAtom` persists the list under `localStorage` key `dia.drafts`; `lastTargetAtom` persists the last sent target under `dia.drafts.lastTarget`. Attachments are not stored in a draft: pasted images can be megabytes of base64, and `localStorage` holds about 5 MB per origin.
* **Sending to a project.** The page gives the draft a new pane id in `sentAs` and sends `CreateTab` with `worktree: WorktreeStart | null` and `firstMessage`. The Host creates the tab and then calls `runs.send(paneId, text, 'queue', attachments)`. When a `WorkspaceChanged` holds a tab whose pane id is a draft's `sentAs`, the renderer deletes that draft and records its target as the last target. A `PaneCreateFailed` for `sentAs` shows its reason on the page, and the draft stays.
* **Sending to a plugin target.** A plugin adds a `ThreadTargetEntry` to `ThreadTargetsSlot` (`plugins/dia-chat/slots.ts`); its `send(text)` starts the thread and shows it, or fails with a reason string. A draft names the entry as `PluginThreadTarget{plugin, id}`. `dia-org` adds the Assistant entry, which calls `AskAssistant` and shows the run.
* **Workspace control.** `dia-git` serves `ReadBranches` and `SwitchBranch` (`plugins/dia-git/calls.ts`). Switching refuses while tracked files have changes (`UncommittedChanges`). A worktree's base defaults to `origin`'s HEAD branch, else the checked-out branch; `dia-worktrees` fetches the base's remote before `git worktree add -b <branch> <path> <base>`, and a failed fetch is logged and the add still runs.
* **Entry points.** `actions.newThread(target?)` opens the page for `target`, else for `defaultThreadTarget()`: the visible tab's project, else the last target, else the first project. It reuses the target's empty draft. The sidebar header button, `Ctrl N`, the `New thread` palette command and each project's New thread call it.

### Consequences

* Good, because every target starts from one page, and a plugin adds a target with one `addEntry`.
* Good, because the first message reaches the run even though the page unmounts when the tab appears.
* Bad, because drafts do not follow the user to another machine or profile, and a cleared renderer profile loses them.
* Bad, because attachments on an unsent draft are lost when the page unmounts.
* `PROTOCOL_VERSION` is `0.0.33`: `CreateTabRequest` replaced `useWorktree` with `worktree` and added `firstMessage`.

## Pros and Cons of the Options

### Drafts in renderer `localStorage`

* Good, because no IPC, Host table or migration is needed.
* Bad, because a draft lives in one renderer profile only.

### Drafts in the Host database

* Good, because drafts would survive a renderer profile reset.
* Bad, because it adds `DiaRpcs` commands and a table for state that only the renderer reads.

### Keep the New agent form

* Good, because it needs no new view.
* Bad, because the first message is still typed after the tab exists, and the Assistant still has a separate start.

## More Information

* ADR-0081 separates threads from org agents; the Assistant is a thread target, not a project.
* ADR-0061 defines list slots.

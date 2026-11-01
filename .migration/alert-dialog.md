# alert-dialog

2026-11-01, transformation engine (legacy `new-york`), migrated to `@base-ui/react/alert-dialog`.

## Changed

* `src/renderer/src/components/ui/alert-dialog.tsx`: `Overlay` → `Backdrop`, `Content` → `Popup`; `data-[state=…]` → `data-open` / `data-closed`. `AlertDialogAction` and `AlertDialogCancel` are both `AlertDialogPrimitive.Close` with the user's `buttonVariants` classes, and gained `data-slot="alert-dialog-action"` / `"alert-dialog-cancel"`.
* `AlertDialogDescription asChild` → `render={<div className="flex flex-col gap-2">…</div>}` in `src/renderer/src/components/workspace-problems.tsx:158` and `plugins/agent-overview/retire-agent-dialog.tsx:71`.
* Leftover scan: clean.

## Left alone

* Nothing.

## Behavior changes

* Base UI has no `Action` part, and the base-nova golden makes `AlertDialogAction` a plain `Button` that does not close the dialog. This migration builds it on `Close` instead, so it still closes on click as Radix's `Action` did. No call site uses `AlertDialogAction`; both alert dialogs use a plain `Button` for the confirm action.

## Verify by hand

* Archive an agent that has a worktree: the dialog shows the worktree path; Cancel closes it; clicking the backdrop does not close it.
* Workspace problems → Delete: the destructive button shows "Deleting…" while busy and Cancel is disabled meanwhile.

# Background archive and delete of threads

Scope: module. Renderer only, in the `dia-threads` plugin. Brief: archiving and deleting a thread must not block other work. Governing decisions: ADR-0023 (what Archive and Delete remove), `docs/designs/archive-delete-agents.md` (the host flow, unchanged), `DESIGN.md` Toast section (a failure with no dialog shows an error toast).

## Success criteria

1. After the user confirms Archive or Delete in `RetireThreadDialog`, the dialog closes before `actions.archiveTab` / `actions.deleteTab` resolves.
2. While that call is pending, the thread's sidebar row is muted, its second line reads `Archiving…` or `Deleting…`, clicking it or pressing `Enter` on it does not call `actions.selectTab`, and its row menu has no Archive or Delete items. The row in the Archived threads settings page is muted, reads `Deleting…` and has no menu while its delete is pending.
3. When the call resolves with a reason, an error toast appears with title `Could not archive <name>` / `Could not delete <name>`, the reason as description, and a `Try again` action that starts the same retirement again. The row returns to its normal state.
4. When the call rejects, the toast description is `The connection to dia's background process was lost.`
5. In the running app, the user can switch to and type in another thread while a worktree thread is archiving, and the archived row leaves the sidebar when the host finishes.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Owner of the retiring state | A module-level store in the renderer (`plugins/dia-threads/background-retirement.ts`) | User decision. No RPC or `PROTOCOL_VERSION` change; the host's `retiringRef` stays private. A window reload during a retirement shows the row as normal until the host finishes |
| Store mechanism | A `Map<PaneId, Retirement>` with listeners, read through `useSyncExternalStore` | Precedent: `src/renderer/src/lib/list-slots.ts`. An Effect `Atom` needs a registry to write from the toast's action handler, which runs outside React |
| When an entry clears on success | When the call resolves with `null` | The host publishes `WorkspaceChanged` before the call returns (`pane-workspace.ts:80`), but the renderer receives that frame on the `SubscribeEvents` stream, separately from the RPC result. No code guarantees their arrival order. In a dev build on 2026-11-18, a 4.6 s archive delivered `WorkspaceChanged` 1 ms before the row left the sidebar, and the row never returned to its normal state. If a flash is seen later, clear the entry on the first workspace change that no longer lists the pane as an open tab instead |
| A second retirement of a pane already retiring | Ignored, with a debug log | Defensive: the row hides its menu and the failure toast closes when a retirement starts, so no UI path reaches it. The host would fail a second call with `TabNotFoundError` (`markRetiring`, `pane-workspace.ts:670`) |
| Failure toast duration | `timeout: 0` (stays until closed) | A background failure the user did not watch for must not disappear after Base UI's default 5000 ms (`node_modules/@base-ui/react/toast/useToastManager.d.ts`) |
| Failure toasts per pane | At most one. The store keeps the failure toast id per pane and closes it (`toast.close(id)`) when a new retirement of that pane starts | A retry from the dialog or from `Try again` that fails again must not leave two toasts for one thread |
| `Try again` | Starts the same retirement through `retireInBackground`, without the dialog | The user already confirmed once |
| No-worktree archive in the sidebar | Routed through `retireInBackground` instead of a direct `actions.archiveTab` call | Today its failure reason is dropped; one path gives it the same muted row and toast |
| Visible thread being archived | Unchanged: it stays visible until the host switches tabs | The host refuses to start a session for a retiring pane (`isRemovingTab`, `pane-workspace.ts:289`) |

## Interface

### `plugins/dia-threads/background-retirement.ts` (new)

```ts
/** Which change is made to a thread: archiving it, or deleting it. */
export type Retirement = 'archive' | 'delete'

/** The thread a retirement applies to: its pane and the name the failure toast shows. */
export interface RetirementTarget {
  readonly paneId: PaneId
  readonly name: string
}

/** The words for each retirement: the button verb, the in-progress text, and the failure toast title for a thread named `name`. */
export const RETIREMENT_COPY: Record<
  Retirement,
  { readonly verb: string; readonly running: string; readonly failedTitle: (name: string) => string }
>

/**
 * Starts archiving or deleting `target` without waiting for it. While the host works,
 * {@link useRetirement} returns `retirement` for the target's pane. When the host refuses or the
 * connection is lost, shows one error toast naming the thread with a `Try again` action. A call for
 * a pane that is already being retired is ignored. Call it only after the user has confirmed.
 */
export const retireInBackground = (target: RetirementTarget, retirement: Retirement): void

/** The retirement in progress for `paneId`, or `null`. Re-renders the caller when it starts or ends. */
export function useRetirement(paneId: PaneId): Retirement | null
```

`Retirement` moves here from `retire-thread-dialog.tsx`; its importers (`thread-row.tsx`, `threads-sidebar.tsx`, `project-group.tsx`) import it from here.

### `RetireThreadDialog` (changed)

Props unchanged. Confirm calls `retireInBackground({ paneId: tab.config.paneId, name: tab.name }, retirement)` then `onClose()`. The `Phase` state, the spinner, the failure paragraph, `Try again` and the local `COPY` are removed; the verb comes from `RETIREMENT_COPY`. `onOpenChange` closes unconditionally. The JSDoc becomes: "Confirms archiving or deleting the thread of `tab`, saying what is removed and what stays, then starts the change in the background and closes. A failure is reported by a toast."

### `ThreadRow` (changed)

Reads `useRetirement(row.paneId)`. When non-null: the name and second line use `text-ink-muted`, the second line reads `RETIREMENT_COPY[retirement].running` (also in the accessible label and tooltip), clicking or pressing `Enter` does nothing, `aria-disabled` is set, and the context menu omits the Archive/Delete group.

### `ThreadsSidebar` (changed)

`retire` calls `retireInBackground` for a no-worktree archive instead of `actions.archiveTab`.

### `ArchivedThreadsSettings` (changed)

`ArchivedRow` reads `useRetirement(tab.config.paneId)`. When `'delete'`: the name is muted, a `Deleting…` caption follows it, the link does nothing and the menu trigger is not rendered.

### `DESIGN.md` (changed)

- Toast: "A failure toast may carry one action, such as `Try again`. A failure toast for an action that ran in the background stays until the user closes it."
- Agent Overview: a row whose thread is being archived or deleted is muted, reads `Archiving…` / `Deleting…` as its second line, cannot be opened and has no Archive or Delete menu items.

### `docs/designs/archive-delete-agents.md` (changed)

The dialog bullet (line 71) says the dialog closes on confirm, the thread's row shows `Archiving…` / `Deleting…`, and a toast with `Try again` reports a failure; it also corrects the file path to `plugins/dia-threads/retire-thread-dialog.tsx`. The Failure decision (line 24) says the toast, not the dialog, offers `Try again`. Both cite this spec.

### Logging

`retireInBackground` logs at info when a retirement starts and ends, and at warning when it fails, with `paneId` and `retirement`, through `Effect.runFork(Effect.log…)` as `archived-threads-settings.tsx` does.

### Tests

`background-retirement.test.ts`: start, a duplicate call ignored, the reason toast, the rejection toast, `Try again` starting again and closing the earlier toast. `retire-thread-dialog.test.tsx`, `threads-sidebar.test.tsx` and `archived-threads-settings.test.tsx` cover criteria 1 and 2.

## Not changed

Host `PaneWorkspace.retireTab`, the RPC group and `PROTOCOL_VERSION`, the dialog's body copy, unarchive, the chat plugin.

## Refinement record

| Round | Finding | Tag | Outcome |
| --- | --- | --- | --- |
| 1 | The entry clears on resolve; the row can show normal before the workspace update arrives | major | Applied as a decision: the order is unverified, verify-in-app checks it, and the fallback is named |
| 1 | In-progress and failure strings duplicated across consumers; dialog `COPY` loses its home | major | Applied: `RETIREMENT_COPY` |
| 1 | `DESIGN.md` Toast and Agent Overview sections do not describe the action toast or the retiring row | major | Applied |
| 1 | `retireInBackground` takes the whole `Tab` but needs only pane id and name | minor | Applied: `RetirementTarget` |
| 1 | A repeated failure leaves two `timeout: 0` toasts for one pane | minor | Applied: one failure toast per pane |
| 1 | Dialog JSDoc and `onOpenChange` guard become wrong | minor | Applied |
| 1 | Criterion 2 omits `Enter` | minor | Applied |
| 1 | No tests named | minor | Applied |
| 2 | Reason for ignoring a duplicate call is false after the one-toast-per-pane rule | minor | Applied |
| 2 | Design-note update omits line numbers and the stale file path | minor | Applied |
| 2 | None of blocker or major standing | - | Stopped early |

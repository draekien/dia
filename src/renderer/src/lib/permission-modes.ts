import type { PermissionMode, StartupPermissionMode } from '@shared/domain/pane'

/**
 * The permission modes offered by a running pane's live switcher, paired with
 * their human-readable labels, in menu order. Includes `plan` (only ever
 * entered mid-session, never at creation). Use to render the live
 * permission-mode `Select` in the pane composer.
 */
export const PERMISSION_MODE_OPTIONS: ReadonlyArray<{
  readonly value: PermissionMode
  readonly label: string
}> = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'dontAsk', label: "Don't ask" }
]

/**
 * The permission modes offered when creating a pane, paired with their labels,
 * in menu order. Excludes `plan` — a pane never starts in plan mode, which
 * guarantees a non-plan mode always exists to restore on plan approval. Use to
 * render the mode `Select` in the pane creation form.
 */
export const CREATE_PERMISSION_MODE_OPTIONS: ReadonlyArray<{
  readonly value: StartupPermissionMode
  readonly label: string
}> = [
  { value: 'default', label: 'Default' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'dontAsk', label: "Don't ask" }
]

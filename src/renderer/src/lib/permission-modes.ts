import type { ModelOption } from '@shared/domain/model'
import type { PermissionMode, StartupPermissionMode } from '@shared/domain/pane'

/** A permission mode as a picker shows it: its label and a one-line description. */
export interface PermissionModeOption<M extends PermissionMode> {
  readonly value: M
  readonly label: string
  readonly description: string
}

/**
 * The permission modes offered by a running pane's live switcher, in menu order. Includes `plan`
 * (only ever entered mid-session, never at creation). Use to render the live permission-mode
 * `Select` in the pane composer.
 */
export const PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<PermissionMode>> = [
  {
    value: 'default',
    label: 'Default',
    description: 'Ask before each tool use that no rule allows.'
  },
  { value: 'plan', label: 'Plan', description: 'Explore and plan; ask before editing files.' },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    description: 'Allow file edits without asking; ask before other tool uses.'
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'A classifier allows or blocks each tool use, and asks when unsure.'
  },
  {
    value: 'dontAsk',
    label: "Don't ask",
    description: 'Refuse each tool use that no rule allows, without asking.'
  },
  {
    value: 'bypassPermissions',
    label: 'Full access',
    description: 'Run tools without asking. Plugin changes still ask.'
  }
]

/**
 * The permission modes offered when creating a pane, in menu order: {@link PERMISSION_MODE_OPTIONS}
 * without `plan`. A pane never starts in plan mode, which guarantees a non-plan mode always exists
 * to restore on plan approval. Use to render the mode `Select` in the pane creation form.
 */
export const CREATE_PERMISSION_MODE_OPTIONS: ReadonlyArray<
  PermissionModeOption<StartupPermissionMode>
> = PERMISSION_MODE_OPTIONS.filter(
  (option): option is PermissionModeOption<StartupPermissionMode> => option.value !== 'plan'
)

/** The menu label of `mode`. */
export const permissionModeLabel = (mode: PermissionMode): string =>
  PERMISSION_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode

/**
 * `options` without the modes in `disabled`, except `current`, which stays so a picker can still
 * show the mode a pane is in.
 */
export const offeredPermissionModes = <M extends PermissionMode>(
  options: ReadonlyArray<PermissionModeOption<M>>,
  disabled: ReadonlyArray<PermissionMode>,
  current: PermissionMode
): ReadonlyArray<PermissionModeOption<M>> =>
  options.filter((option) => option.value === current || !disabled.includes(option.value))

/**
 * The permission modes to withhold for an agent on `model`: `disabled` (the modes the adapter's
 * settings turn off), plus `auto` when `model` is known and does not support auto mode. Pass the
 * result as `disabled` to {@link offeredPermissionModes}.
 */
export const disabledPermissionModesFor = (
  disabled: ReadonlyArray<PermissionMode>,
  model: ModelOption | undefined
): ReadonlyArray<PermissionMode> =>
  model?.autoMode === false && !disabled.includes('auto') ? [...disabled, 'auto'] : disabled

import type { PermissionMode } from '@shared/domain/pane'

/** A permission mode {@link startPermissionMode} can return. */
export type HiredStartMode = Extract<PermissionMode, 'auto' | 'bypassPermissions' | 'default'>

/**
 * The permission mode a hired agent session starts in, by ADR-0054's "Mode at session start"
 * table: `auto` when the model supports it and settings do not disable it, else
 * `bypassPermissions` when opted in and not disabled, else `default`.
 * `modelSupportsAuto` is the session model's `ModelOption.autoMode`; `disabled` is
 * `AgentBackend.disabledPermissionModes(cwd)` for the session's cwd; `bypassOptedIn` is whether
 * the hire, or its job title when the hire does not override it, opts into bypass. Not for router
 * sessions or ad-hoc tabs. Pure and does not log; its caller logs the inputs and the result.
 */
export const startPermissionMode = (input: {
  readonly modelSupportsAuto: boolean
  readonly disabled: ReadonlyArray<PermissionMode>
  readonly bypassOptedIn: boolean
}): HiredStartMode => {
  if (input.modelSupportsAuto && !input.disabled.includes('auto')) return 'auto'
  if (input.bypassOptedIn && !input.disabled.includes('bypassPermissions')) {
    return 'bypassPermissions'
  }
  return 'default'
}

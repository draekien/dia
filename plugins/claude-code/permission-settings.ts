import { resolveSettings } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode } from '@shared/domain/pane'
import { Effect, Option, Schema } from 'effect'
import { messageOf } from './idle-query'

const Disable = Schema.optionalKey(Schema.Unknown)

const ModeSwitches = Schema.Struct({
  disableAutoMode: Disable,
  permissions: Schema.optionalKey(
    Schema.Struct({ disableAutoMode: Disable, disableBypassPermissionsMode: Disable })
  )
})

const decodeModeSwitches = Schema.decodeUnknownOption(ModeSwitches)

/**
 * The permission modes that Claude Code settings `settings` turn off: `auto` when
 * `disableAutoMode` or `permissions.disableAutoMode` is `"disable"`, and `bypassPermissions` when
 * `permissions.disableBypassPermissionsMode` is `"disable"`. Any other value of those keys turns
 * off nothing.
 */
export const disabledPermissionModes = (settings: unknown): ReadonlyArray<PermissionMode> => {
  const switches = decodeModeSwitches(settings)
  if (Option.isNone(switches)) return []
  const { disableAutoMode, permissions } = switches.value
  return [
    ...(disableAutoMode === 'disable' || permissions?.disableAutoMode === 'disable'
      ? (['auto'] as const)
      : []),
    ...(permissions?.disableBypassPermissionsMode === 'disable'
      ? (['bypassPermissions'] as const)
      : [])
  ]
}

/**
 * Reads the Claude Code settings that apply to a session started in `cwd` (managed, user, project
 * and local) and returns the permission modes they turn off, as {@link disabledPermissionModes}
 * does. When the settings cannot be read it logs a warning and returns an empty list.
 */
export const readDisabledPermissionModes = Effect.fn('ClaudeCode.readDisabledPermissionModes')(
  function* (cwd: string) {
    const settings = yield* Effect.tryPromise(() => resolveSettings({ cwd })).pipe(
      Effect.map((resolved) => resolved.effective),
      Effect.catch((error) =>
        Effect.logWarning('Could not read Claude Code settings', {
          cwd,
          error: messageOf(error)
        }).pipe(Effect.as({}))
      )
    )
    const disabled = disabledPermissionModes(settings)
    yield* Effect.logDebug('Read disabled permission modes', { cwd, disabled })
    return disabled
  }
)

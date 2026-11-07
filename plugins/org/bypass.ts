import { homedir } from 'node:os'
import type { AgentBackend } from '@dia/plugin'
import { Effect, Option, Ref } from 'effect'

/**
 * Whether any hired agent session could start in `bypassPermissions` (ADR-0054): false while no
 * agent backend is provided, or when the managed or user Claude Code settings the backend reads
 * for the home directory turn `bypassPermissions` off. A project's own settings can still refuse
 * bypass when a session starts there. `backend` holds the provided agent backend, if any.
 */
export const bypassAvailable = Effect.fn('Org.bypassAvailable')(function* (
  backend: Ref.Ref<Option.Option<AgentBackend>>
) {
  const provided = yield* Ref.get(backend)
  if (Option.isNone(provided)) {
    yield* Effect.logDebug('No agent backend is provided, so bypass is unavailable')
    return false
  }
  const disabled = yield* provided.value.disabledPermissionModes(homedir())
  return !disabled.includes('bypassPermissions')
})

import { homedir } from 'node:os'
import type { AgentAdapters } from '@dia-plugin/dia-agent-adapters/registry'
import { Effect, Option, Ref } from 'effect'

/**
 * Whether any hired agent session could start in `bypassPermissions` (ADR-0054): false while the
 * adapter `adapter` is not registered, or when the managed or user Claude Code settings its backend
 * reads for the home directory turn `bypassPermissions` off. A project's own settings can still
 * refuse bypass when a session starts there. `adapters` holds the provided adapter registry, if any.
 */
export const bypassAvailable = Effect.fn('Org.bypassAvailable')(function* (
  adapters: Ref.Ref<Option.Option<AgentAdapters>>,
  adapter: string
) {
  const registry = yield* Ref.get(adapters)
  const registered = Option.isNone(registry) ? Option.none() : yield* registry.value.get(adapter)
  if (Option.isNone(registered)) {
    yield* Effect.logDebug('The adapter is not registered, so bypass is unavailable', { adapter })
    return false
  }
  const disabled = yield* registered.value.backend.disabledPermissionModes(homedir())
  return !disabled.includes('bypassPermissions')
})

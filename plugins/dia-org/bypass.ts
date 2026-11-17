import { homedir } from 'node:os'
import type { ModelPreferences } from '@dia/plugin'
import type { AgentAdapters } from '@dia-plugin/dia-agent-adapters/registry'
import { Effect, Option, Ref, Stream } from 'effect'

/**
 * Whether any hired agent session could start in `bypassPermissions` (ADR-0054). `selections` holds
 * each job title's model selection, null for a job title that takes the default model. A session
 * can run on the adapter of a non-null selection, and on any registered adapter for a null one.
 * It is false while none of those adapters is registered, or when the managed or user Claude Code
 * settings each one's backend reads for the home directory turn `bypassPermissions` off. A
 * project's own settings can still refuse bypass when a session starts there. `adapters` holds the
 * provided adapter registry, if any.
 */
export const bypassAvailable = Effect.fn('Org.bypassAvailable')(function* (
  adapters: Ref.Ref<Option.Option<AgentAdapters>>,
  selections: ReadonlyArray<ModelPreferences.ModelSelection | null>
) {
  const registry = yield* Ref.get(adapters)
  if (Option.isNone(registry)) {
    yield* Effect.logDebug('No adapter registry, so bypass is unavailable')
    return false
  }
  const registered = Option.getOrElse(yield* Stream.runHead(registry.value.adapters), () => [])
  const named = selections.flatMap((selection) => (selection === null ? [] : [selection.backend]))
  const candidates = selections.includes(null)
    ? registered.map((adapter) => adapter.id)
    : [...new Set(named)]
  for (const id of candidates) {
    const adapter = yield* registry.value.get(id)
    if (Option.isNone(adapter)) continue
    const disabled = yield* adapter.value.backend.disabledPermissionModes(homedir())
    if (!disabled.includes('bypassPermissions')) return true
  }
  yield* Effect.logDebug('No candidate adapter allows bypass', { candidates })
  return false
})

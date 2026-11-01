import { META_REPO_KEY } from '@shared/plugin/api'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Option, Predicate } from 'effect'
import type { SessionAdditions } from '../session/agent-backend'

/**
 * The meta repo (ADR-0025), as the `meta` plugin provides it under `META_REPO_KEY`.
 * `forNewSession` reads what the meta repo adds to an agent session now; run it each time a
 * session starts so a change to the repo applies to sessions started after it. It never fails.
 */
export interface MetaRepo {
  readonly forNewSession: Effect.Effect<SessionAdditions>
}

const NO_ADDITIONS: SessionAdditions = { systemPromptAppend: '', pluginPaths: [] }

const isMetaRepo = (value: unknown): value is MetaRepo =>
  Predicate.hasProperty(value, 'forNewSession') && Effect.isEffect(value.forNewSession)

/**
 * Reads the {@link SessionAdditions} for a session starting now from the {@link MetaRepo} the
 * loaded `meta` plugin provides. It never fails: when the plugin is not loaded, or what it
 * provides is not a `MetaRepo`, it logs why and returns additions that add nothing. Call it once
 * per session start; a plugin reload applies from the next call.
 */
export const resolveSessionAdditions = Effect.fn('MetaRepo.resolveSessionAdditions')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const provided = yield* registry.inject(META_REPO_KEY)
  if (Option.isNone(provided)) {
    yield* Effect.logDebug('The meta plugin is not loaded; the session gets no meta additions')
    return NO_ADDITIONS
  }
  if (!isMetaRepo(provided.value)) {
    yield* Effect.logError('The meta repo service does not have a forNewSession effect')
    return NO_ADDITIONS
  }
  return yield* provided.value.forNewSession.pipe(
    Effect.catchDefect((defect) =>
      Effect.logError('The meta repo forNewSession effect died', { defect }).pipe(
        Effect.as(NO_ADDITIONS)
      )
    )
  )
})

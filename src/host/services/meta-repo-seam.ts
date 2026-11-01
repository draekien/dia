import {
  MetaRepoFailed,
  type MetaRepoPushResult,
  type MetaRepoStateResult
} from '@shared/domain/meta-repo'
import { META_REPO_KEY } from '@shared/plugin/api'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Option, Predicate } from 'effect'
import type { SessionAdditions } from '../session/agent-backend'

/**
 * The meta repo (ADR-0025), as the `meta` plugin provides it under `META_REPO_KEY`. None of its
 * members fails.
 *
 * `forNewSession` reads what the meta repo adds to an agent session now; run it each time a
 * session starts so a change to the repo applies to sessions started after it. `state` reads the
 * remote and branch a push uses. `setRemote` sets the remote to `url` and returns the new state.
 * `push` scans the commits the remote does not have for secrets (ADR-0047) and pushes the current
 * branch only when the scan finds none.
 */
export interface MetaRepo {
  readonly forNewSession: Effect.Effect<SessionAdditions>
  readonly state: Effect.Effect<MetaRepoStateResult>
  readonly setRemote: (url: string) => Effect.Effect<MetaRepoStateResult>
  readonly push: Effect.Effect<MetaRepoPushResult>
}

const NO_ADDITIONS: SessionAdditions = { systemPromptAppend: '', pluginPaths: [] }

const isMetaRepo = (value: unknown): value is MetaRepo =>
  Predicate.hasProperty(value, 'forNewSession') &&
  Effect.isEffect(value.forNewSession) &&
  Predicate.hasProperty(value, 'state') &&
  Effect.isEffect(value.state) &&
  Predicate.hasProperty(value, 'setRemote') &&
  Predicate.isFunction(value.setRemote) &&
  Predicate.hasProperty(value, 'push') &&
  Effect.isEffect(value.push)

const resolveMetaRepo = Effect.fnUntraced(function* (registry: Pick<PluginRegistry, 'inject'>) {
  const provided = yield* registry.inject(META_REPO_KEY)
  if (Option.isNone(provided)) {
    yield* Effect.logDebug('The meta plugin is not loaded')
    return Option.none<MetaRepo>()
  }
  if (!isMetaRepo(provided.value)) {
    yield* Effect.logError('The meta repo service does not have the MetaRepo members')
    return Option.none<MetaRepo>()
  }
  return Option.some(provided.value)
})

/**
 * Runs `use` with the {@link MetaRepo} the loaded `meta` plugin provides, for the Settings page's
 * meta repo calls. It never fails: when the plugin is not loaded, what it provides is not a
 * `MetaRepo`, or `use` dies, it logs why and returns a `MetaRepoFailed` that says so.
 */
export const withMetaRepo = Effect.fn('MetaRepo.with')(function* <A>(
  registry: Pick<PluginRegistry, 'inject'>,
  use: (repo: MetaRepo) => Effect.Effect<A>
) {
  const repo = yield* resolveMetaRepo(registry)
  if (Option.isNone(repo)) {
    return MetaRepoFailed.make({ message: 'The meta plugin is not loaded.' })
  }
  return yield* use(repo.value).pipe(
    Effect.catchDefect((defect) =>
      Effect.logError('A meta repo call died', { defect }).pipe(
        Effect.as(MetaRepoFailed.make({ message: 'The meta repo call failed unexpectedly.' }))
      )
    )
  )
})

/**
 * Reads the {@link SessionAdditions} for a session starting now from the {@link MetaRepo} the
 * loaded `meta` plugin provides. It never fails: when the plugin is not loaded, or what it
 * provides is not a `MetaRepo`, it logs why and returns additions that add nothing. Call it once
 * per session start; a plugin reload applies from the next call.
 */
export const resolveSessionAdditions = Effect.fn('MetaRepo.resolveSessionAdditions')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const repo = yield* resolveMetaRepo(registry)
  if (Option.isNone(repo)) return NO_ADDITIONS
  return yield* repo.value.forNewSession.pipe(
    Effect.catchDefect((defect) =>
      Effect.logError('The meta repo forNewSession effect died', { defect }).pipe(
        Effect.as(NO_ADDITIONS)
      )
    )
  )
})

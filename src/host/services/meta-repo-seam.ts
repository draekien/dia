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

const SESSION_MEMBERS = ['forNewSession'] as const
const ALL_MEMBERS = ['forNewSession', 'state', 'setRemote', 'push'] as const

const hasMembers = (value: unknown, members: ReadonlyArray<keyof MetaRepo>): value is MetaRepo =>
  members.every(
    (member) =>
      Predicate.hasProperty(value, member) &&
      (member === 'setRemote' ? Predicate.isFunction : Effect.isEffect)(value[member])
  )

const NOT_LOADED = MetaRepoFailed.make({ message: 'The meta plugin is not loaded.' })

const lacksMembers = (members: ReadonlyArray<keyof MetaRepo>) =>
  Effect.logError('The meta repo service lacks MetaRepo members', { members })

/**
 * Runs `run` with the {@link MetaRepo} the loaded `meta` plugin provides, for the Settings page's
 * meta repo calls, holding the plugin open until `run` ends. It never fails: when the plugin is
 * not loaded, what it provides is not a `MetaRepo`, the plugin closes while `run` runs, or `run`
 * dies, it logs why and returns a `MetaRepoFailed` that says so.
 */
export const withMetaRepo = Effect.fn('MetaRepo.with')(function* <A>(
  registry: Pick<PluginRegistry, 'use'>,
  run: (repo: MetaRepo) => Effect.Effect<A>
) {
  const result = yield* registry
    .use(META_REPO_KEY, (value) =>
      hasMembers(value, ALL_MEMBERS)
        ? run(value).pipe(
            Effect.catchDefect((defect) =>
              Effect.logError('A meta repo call died', { defect }).pipe(
                Effect.as(
                  MetaRepoFailed.make({ message: 'The meta repo call failed unexpectedly.' })
                )
              )
            )
          )
        : lacksMembers(ALL_MEMBERS).pipe(Effect.as(NOT_LOADED))
    )
    .pipe(
      Effect.catchTag('ServiceWithdrawnError', () =>
        Effect.succeed(
          Option.some(
            MetaRepoFailed.make({ message: 'The meta plugin was unloaded during the call.' })
          )
        )
      )
    )
  return Option.getOrElse(result, () => NOT_LOADED)
})

/**
 * Reads the {@link SessionAdditions} for a session starting now from the {@link MetaRepo} the
 * loaded `meta` plugin provides. It needs only `forNewSession`, so an older `meta` plugin without
 * the push members still adds to sessions. It never fails: when the plugin is not loaded, or what
 * it provides has no `forNewSession` effect, it logs why and returns additions that add nothing. Call it once
 * per session start; a plugin reload applies from the next call.
 */
export const resolveSessionAdditions = Effect.fn('MetaRepo.resolveSessionAdditions')(function* (
  registry: Pick<PluginRegistry, 'use'>
) {
  const additions = yield* registry
    .use(META_REPO_KEY, (value) =>
      hasMembers(value, SESSION_MEMBERS)
        ? value.forNewSession.pipe(
            Effect.catchDefect((defect) =>
              Effect.logError('The meta repo forNewSession effect died', { defect }).pipe(
                Effect.as(NO_ADDITIONS)
              )
            )
          )
        : lacksMembers(SESSION_MEMBERS).pipe(Effect.as(NO_ADDITIONS))
    )
    .pipe(
      Effect.catchTag('ServiceWithdrawnError', (error) =>
        Effect.logWarning('Started the session without meta repo additions', {
          message: error.message
        }).pipe(Effect.as(Option.some(NO_ADDITIONS)))
      )
    )
  return Option.getOrElse(additions, () => NO_ADDITIONS)
})

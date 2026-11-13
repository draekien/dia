import {
  MetaRepoFailed,
  type MetaRepoPushResult,
  type MetaRepoStateResult
} from '@shared/domain/meta-repo'
import { ServiceKey } from '@shared/plugin/api'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Option, Predicate } from 'effect'

/**
 * What dia adds to an agent session on top of the agent's own configuration.
 * `systemPromptAppend` is text appended to the agent's system prompt; an empty string appends
 * nothing. `pluginPaths` are absolute paths of local Claude Code plugin directories loaded into
 * the session.
 */
export interface SessionAdditions {
  readonly systemPromptAppend: string
  readonly pluginPaths: ReadonlyArray<string>
}

/**
 * The meta repo (ADR-0025), as the `meta` plugin provides it under {@link MetaRepoKey}. None of its
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

/**
 * What {@link MetaRepoKey} reads as: a {@link MetaRepo} whose members other than `forNewSession` may
 * be missing, because an older `meta` plugin provides only `forNewSession`.
 */
export type SessionMetaRepo = Pick<MetaRepo, 'forNewSession'> &
  Partial<Omit<MetaRepo, 'forNewSession'>>

/** {@link SessionAdditions} that add nothing; use them when no meta repo is provided. */
export const NO_SESSION_ADDITIONS: SessionAdditions = { systemPromptAppend: '', pluginPaths: [] }

const ALL_MEMBERS = ['forNewSession', 'state', 'setRemote', 'push'] as const

const hasMember = (value: unknown, member: keyof MetaRepo): boolean =>
  Predicate.hasProperty(value, member) &&
  (member === 'setRemote' ? Predicate.isFunction : Effect.isEffect)(value[member])

const hasSessionMembers = (value: unknown): value is SessionMetaRepo =>
  hasMember(value, 'forNewSession')

const hasAllMembers = (value: SessionMetaRepo): value is MetaRepo =>
  ALL_MEMBERS.every((member) => hasMember(value, member))

/**
 * The key the `meta` plugin provides its {@link MetaRepo} under. It reads as a
 * {@link SessionMetaRepo} and accepts a value whose `forNewSession` is an effect; any other value
 * reads as not provided. Host code reads it through {@link withMetaRepo} and
 * `ctx.whenProvided` in `dia-runs`, one operation per call (ADR-0055).
 */
export const MetaRepoKey = ServiceKey.make('metaRepo', hasSessionMembers)

const NOT_LOADED = MetaRepoFailed.make({ message: 'The meta plugin is not loaded.' })

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
    .use(MetaRepoKey, (value) =>
      hasAllMembers(value)
        ? run(value).pipe(
            Effect.catchDefect((defect) =>
              Effect.logError('A meta repo call died', { defect }).pipe(
                Effect.as(
                  MetaRepoFailed.make({ message: 'The meta repo call failed unexpectedly.' })
                )
              )
            )
          )
        : Effect.logError('The meta repo service lacks MetaRepo members', {
            members: ALL_MEMBERS
          }).pipe(Effect.as(NOT_LOADED))
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

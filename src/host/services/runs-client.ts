import type { PaneConfig } from '@shared/domain/pane'
import { Context, Effect, Layer, Option, Stream } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { type RunSpec, type Runs, RunsKey, RunsNotLoadedError } from './runs-seam'
import type { WorktreeCreateError, WorktreeReattachError } from './worktrees-seam'

const NOT_LOADED = 'The dia-runs plugin is not loaded'

/**
 * The part of {@link Runs} the kernel's tabs use, delegating to the run service the loaded
 * `dia-runs` plugin provides at the time of each call. `changes` follows the provider across
 * reloads. With no provider, `open` fails with {@link RunsNotLoadedError}, `isLive` is false,
 * `discoverSessions` is empty, and every other member logs and does nothing. Provide it with
 * {@link RunsClientLive}.
 */
export class RunsClient extends Context.Service<
  RunsClient,
  Pick<
    Runs,
    | 'close'
    | 'retire'
    | 'isLive'
    | 'setThinkingLevel'
    | 'setPermissionMode'
    | 'setModel'
    | 'changes'
    | 'discoverSessions'
  > & {
    readonly open: (
      spec: RunSpec
    ) => Effect.Effect<PaneConfig, WorktreeCreateError | WorktreeReattachError | RunsNotLoadedError>
  }
>()('RunsClient') {}

/** The live {@link RunsClient}. Requires `HostPlugins`. */
export const RunsClientLive = Layer.effect(
  RunsClient,
  Effect.gen(function* () {
    const registry = yield* HostPlugins

    // biome-ignore lint/plugin/noRegistryInject: a run lives in `dia-runs`' own scope, so a `use` lease would only block its reload (ADR-0074)
    const current = registry.inject(RunsKey)

    const withRuns = <A>(name: string, fallback: A, run: (runs: Runs) => Effect.Effect<A>) =>
      Effect.flatMap(
        current,
        Option.match({
          onSome: run,
          onNone: () =>
            Effect.logWarning(`${NOT_LOADED}; ${name} did nothing`).pipe(Effect.as(fallback))
        })
      )

    const changes = Stream.merge(
      Stream.make(RunsKey.name),
      registry.changes.pipe(Stream.filter((key) => key === RunsKey.name))
    ).pipe(
      Stream.mapEffect(() => current),
      Stream.tap((provided) =>
        Effect.logInfo('Following the run service provider', { loaded: Option.isSome(provided) })
      ),
      Stream.switchMap(Option.match({ onNone: () => Stream.empty, onSome: (runs) => runs.changes }))
    )

    return RunsClient.of({
      open: (spec) =>
        Effect.gen(function* () {
          const runs = yield* current
          if (Option.isNone(runs)) return yield* new RunsNotLoadedError({ runId: spec.runId })
          return yield* runs.value.open(spec)
        }),
      close: (runId) => withRuns('close', undefined, (runs) => runs.close(runId)),
      retire: (runId, as) => withRuns('retire', undefined, (runs) => runs.retire(runId, as)),
      isLive: (runId) => withRuns('isLive', false, (runs) => runs.isLive(runId)),
      setThinkingLevel: (runId, level) =>
        withRuns('setThinkingLevel', undefined, (runs) => runs.setThinkingLevel(runId, level)),
      setPermissionMode: (runId, mode) =>
        withRuns('setPermissionMode', undefined, (runs) => runs.setPermissionMode(runId, mode)),
      setModel: (runId, model) =>
        withRuns('setModel', undefined, (runs) => runs.setModel(runId, model)),
      changes,
      discoverSessions: (directory) =>
        withRuns('discoverSessions', [], (runs) => runs.discoverSessions(directory))
    })
  })
)

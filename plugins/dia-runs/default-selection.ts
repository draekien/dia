import type { ModelCatalogState, ModelPreferences } from '@dia/plugin'
import type { AgentAdapter } from '@dia-plugin/dia-agent-adapters/registry'
import { Effect, Option, Stream } from 'effect'

type Selection = ModelPreferences.ModelSelection

const firstReadySelection = (
  adapters: ReadonlyArray<AgentAdapter>,
  states: ReadonlyArray<ModelCatalogState>
): Option.Option<Selection> => {
  for (const [index, state] of states.entries()) {
    const model = state._tag === 'Ready' ? state.models[0] : undefined
    const adapter = adapters[index]
    if (model !== undefined && adapter !== undefined) {
      return Option.some({ backend: adapter.id, model: model.value })
    }
  }
  return Option.none()
}

/**
 * The model a run starts with when its caller has no choice of its own: the stored
 * `defaults.selection` from `preferences` when there is one, else the first model of the first
 * adapter in `adapters` order whose catalog (read through `models`) is `Ready` with a model.
 * Waits while no adapter has such a catalog, and answers none at once while no adapter is
 * registered.
 */
export const makeDefaultSelection = (deps: {
  readonly preferences: Effect.Effect<ModelPreferences.ModelPreferences>
  readonly adapters: Stream.Stream<ReadonlyArray<AgentAdapter>>
  readonly models: (adapter: string) => Stream.Stream<ModelCatalogState>
}): Effect.Effect<Option.Option<Selection>> =>
  Effect.gen(function* () {
    const stored = (yield* deps.preferences).defaults.selection
    if (stored !== undefined) return Option.some(stored)
    const chosen = yield* deps.adapters.pipe(
      Stream.switchMap((adapters) =>
        adapters.length === 0
          ? Stream.succeed(Option.none<Selection>())
          : Stream.zipLatestAll(...adapters.map((adapter) => deps.models(adapter.id))).pipe(
              Stream.map((states) => firstReadySelection(adapters, states)),
              Stream.filter(Option.isSome)
            )
      ),
      Stream.runHead,
      Effect.map(Option.flatten)
    )
    yield* Effect.logDebug('Chose the default selection', { selection: Option.getOrNull(chosen) })
    return chosen
  })

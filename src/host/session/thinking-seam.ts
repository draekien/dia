import type { EffortLevel, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk'
import type { ThinkingLevel } from '@shared/domain/pane'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Data, Effect, Option, Predicate } from 'effect'

/**
 * Service key under which the `thinking` plugin provides a {@link ThinkingOptionsFactory}.
 */
export const THINKING_OPTIONS_KEY = 'thinkingOptions'

/**
 * The Agent SDK query options that enact a thinking level. Spread the result into a query's
 * `options`; an absent field leaves the SDK's own default in effect.
 */
export interface ThinkingOptions {
  readonly thinking?: ThinkingConfig
  readonly effort?: EffortLevel
}

/** Maps a pane's {@link ThinkingLevel} to its {@link ThinkingOptions}; the value a plugin provides under {@link THINKING_OPTIONS_KEY}. */
export type ThinkingOptionsFactory = (level: ThinkingLevel) => ThinkingOptions

const noThinkingOptions: ThinkingOptions = {}

class ThinkingOptionsError extends Data.TaggedError('ThinkingOptionsError')<{
  readonly cause: unknown
}> {}

/**
 * Resolves the query options for `level` with the factory the `thinking` plugin provides under
 * {@link THINKING_OPTIONS_KEY}. It never fails: when the plugin is not loaded, provides a
 * non-function, or throws, the problem is logged and the result is `{}`, so the SDK's default
 * thinking applies and the pane's chosen level is ignored. Call it once per session start; a
 * plugin reload applies from the next call.
 */
export const resolveThinkingOptions = Effect.fn('ThinkingOptions.resolve')(function* (
  registry: Pick<PluginRegistry, 'inject'>,
  level: ThinkingLevel
) {
  const provided = yield* registry.inject(THINKING_OPTIONS_KEY)
  if (Option.isNone(provided)) {
    yield* Effect.logWarning('The thinking plugin is not loaded; the thinking level is ignored', {
      level
    })
    return noThinkingOptions
  }
  if (!Predicate.isFunction(provided.value)) {
    yield* Effect.logWarning('The thinkingOptions service is not a function; ignoring the level', {
      received: typeof provided.value
    })
    return noThinkingOptions
  }
  const factory = provided.value as ThinkingOptionsFactory
  const options = yield* Effect.try({
    try: () => factory(level),
    catch: (cause) => new ThinkingOptionsError({ cause })
  }).pipe(
    Effect.catch((error) =>
      Effect.logError('The thinking plugin threw; the thinking level is ignored', {
        level,
        cause: error.cause
      }).pipe(Effect.as(noThinkingOptions))
    )
  )
  yield* Effect.logInfo('Resolved thinking options', { level, options })
  return options
})

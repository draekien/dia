import { type EffortLevel, type ModelCatalogState, ServiceKey } from '@dia/plugin'
import { Data, type Effect, type Option, Predicate, type Scope, Stream } from 'effect'
import type { AgentBackend } from './backend'

/** One text generation call: the model follows `instructions` and answers `input` with text only. */
export interface TextGenerationRequest {
  readonly instructions: string
  readonly input: string
  readonly model: string
  readonly effort: EffortLevel
}

/** The call failed or answered with no text; `reason` is a sentence for the log. */
export class TextGenerationFailed extends Data.TaggedError('TextGenerationFailed')<{
  readonly reason: string
}> {}

/** An adapter's one-shot text generation: no tools, no stored session. Interrupting `generate` stops the call. */
export interface TextGeneration {
  /** The model a caller uses when it has no model of this adapter saved. */
  readonly defaultModel: string
  readonly generate: (request: TextGenerationRequest) => Effect.Effect<string, TextGenerationFailed>
}

/** One registered adapter as consumers see it. `id` is the registering plugin's name, set by the registry. */
export interface AgentAdapter {
  readonly id: string
  readonly label: string
  readonly backend: AgentBackend
  /** The adapter's text generation, or none when it registered without one. */
  readonly textGeneration: Option.Option<TextGeneration>
}

/**
 * The adapters loaded in dia. Read it with `ctx.whenProvided([AgentAdaptersKey], …)`, so a reload
 * of `dia-agent-adapters` does not close the reader.
 */
export interface AgentAdapters {
  /**
   * Registers the calling plugin (`ctx.name`) as an adapter until the calling scope closes. A
   * registration under a name already registered replaces it and logs a warning (a reload
   * overlaps); closing the replaced registration's scope afterwards leaves the new one. A
   * `backend` that is not an {@link AgentBackend} registers nothing and logs an error. A
   * `textGeneration` is offered to `adapters` readers with the registration and is replaced and
   * removed with it. A `textGeneration` without a non-empty `defaultModel` and a `generate`
   * function registers the adapter without text generation and logs an error naming `ctx.name`.
   */
  readonly register: (
    ctx: { readonly name: string },
    adapter: {
      readonly label: string
      readonly backend: AgentBackend
      readonly textGeneration?: TextGeneration
    }
  ) => Effect.Effect<void, never, Scope.Scope>
  /** The registered adapters ordered by `label`, then `id`: the current list, then every change. */
  readonly adapters: Stream.Stream<ReadonlyArray<AgentAdapter>>
  /** The adapter registered as `id`, or none (an unknown id is the not-registered case). */
  readonly get: (id: string) => Effect.Effect<Option.Option<AgentAdapter>>
  /**
   * The model catalog of adapter `id`: the current state, then every change.
   * `ModelsUnavailable` with {@link notLoadedMessage} while `id` is not registered.
   */
  readonly models: (id: string) => Stream.Stream<ModelCatalogState>
}

/** Whether `value` has the shape of {@link AgentAdapters}: `register`, `get` and `models` are functions and `adapters` is a `Stream`. */
export const isAgentAdapters = (value: unknown): value is AgentAdapters =>
  Predicate.hasProperty(value, 'register') &&
  Predicate.isFunction(value.register) &&
  Predicate.hasProperty(value, 'get') &&
  Predicate.isFunction(value.get) &&
  Predicate.hasProperty(value, 'models') &&
  Predicate.isFunction(value.models) &&
  Predicate.hasProperty(value, 'adapters') &&
  Stream.isStream(value.adapters)

/** The key `dia-agent-adapters` provides {@link AgentAdapters} under. Read it with `ctx.whenProvided`. */
export const AgentAdaptersKey = ServiceKey.make('agentAdapters', isAgentAdapters)

/** The sentence a run, call or picker shows when adapter `id` is not registered: `<id> is not loaded`. */
export const notLoadedMessage = (id: string): string => `${id} is not loaded`

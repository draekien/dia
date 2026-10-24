import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ConversationMessage } from '@shared/domain/pane'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Data, Effect, Option, Predicate, Ref } from 'effect'
import {
  AssistantMessageReceived,
  type OutboundMessage,
  SessionStarted,
  TurnCompleted,
  TurnErrored
} from './protocol'

/**
 * Service key under which the `session-reducer` plugin provides a {@link SessionEventReducerFactory}.
 * A plugin that replaces the mapping provides its own factory under this key.
 */
export const SESSION_REDUCER_KEY = 'sessionReducer'

/**
 * Folds the Agent SDK's raw message stream into {@link OutboundMessage}s for one agent session.
 * `step` takes one SDK message, in arrival order, and returns the protocol messages it produces
 * in emission order; it returns an empty array for a message with no protocol effect. An instance
 * is stateful and serves one session.
 */
export interface SessionEventReducer {
  readonly step: (message: SDKMessage) => ReadonlyArray<OutboundMessage>
}

/** Creates a fresh {@link SessionEventReducer}; the value a plugin provides under {@link SESSION_REDUCER_KEY}. */
export type SessionEventReducerFactory = () => SessionEventReducer

/**
 * The reducer used when no plugin provides one, or when the provided one fails. It records the
 * session id (`SessionStarted`), shows each completed assistant reply (`AssistantMessageReceived`)
 * and ends turns (`TurnCompleted`, `TurnErrored`); it emits no streaming deltas, tool calls,
 * checkpoints, compaction or command-list messages. It keeps no state between messages.
 */
export const fallbackSessionEventReducer: SessionEventReducerFactory = () => ({
  step: (message) => {
    if (message.type === 'system' && message.subtype === 'init') {
      return [SessionStarted.make({ sessionId: message.session_id })]
    }
    if (message.type === 'assistant') {
      const text = message.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      if (!text) return []
      const conversationMessage: ConversationMessage = { role: 'assistant', content: text }
      return [AssistantMessageReceived.make({ message: conversationMessage })]
    }
    if (message.type === 'result') {
      if (message.subtype === 'success') return [TurnCompleted.make({})]
      const errorMessage = message.errors.length > 0 ? message.errors.join('; ') : message.subtype
      return [TurnErrored.make({ error: { message: errorMessage } })]
    }
    return []
  }
})

class SessionReducerError extends Data.TaggedError('SessionReducerError')<{
  readonly cause: unknown
}> {}

const primaryReducer = (provided: Option.Option<unknown>): Effect.Effect<SessionEventReducer> => {
  if (Option.isNone(provided)) {
    return Effect.logWarning(
      'No session reducer plugin is loaded; using the fallback reducer'
    ).pipe(Effect.as(fallbackSessionEventReducer()))
  }
  if (!Predicate.isFunction(provided.value)) {
    return Effect.logWarning('The sessionReducer service is not a function; using the fallback', {
      received: typeof provided.value
    }).pipe(Effect.as(fallbackSessionEventReducer()))
  }
  const factory = provided.value as SessionEventReducerFactory
  return Effect.try({ try: factory, catch: (cause) => new SessionReducerError({ cause }) }).pipe(
    Effect.catch((error) =>
      Effect.logError('The session reducer plugin failed to create a reducer; using the fallback', {
        cause: error.cause
      }).pipe(Effect.as(fallbackSessionEventReducer()))
    )
  )
}

/**
 * Creates the reducer for one agent session. It uses the factory a loaded plugin provides under
 * {@link SESSION_REDUCER_KEY} when `registry` holds one, and {@link fallbackSessionEventReducer}
 * otherwise. `step` never fails: when the plugin's reducer throws, the error is logged and the
 * session switches to a fresh fallback reducer from that message on, because an ending turn must
 * not depend on a plugin. Call it once per session start or restart; a plugin reload applies from
 * the next call.
 */
export const makeSessionReducer = Effect.fn('SessionReducer.make')(function* (
  registry: Pick<PluginRegistry, 'inject'>
) {
  const provided = yield* registry.inject(SESSION_REDUCER_KEY)
  const active = yield* Ref.make(yield* primaryReducer(provided))

  const step = Effect.fnUntraced(function* (
    message: SDKMessage
  ): Effect.fn.Return<ReadonlyArray<OutboundMessage>> {
    const reducer = yield* Ref.get(active)
    return yield* Effect.try({
      try: () => reducer.step(message),
      catch: (cause) => new SessionReducerError({ cause })
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logError(
            'The session reducer plugin threw; using the fallback for the rest of the session',
            { messageType: message.type, cause: error.cause }
          )
          const fallback = fallbackSessionEventReducer()
          yield* Ref.set(active, fallback)
          return fallback.step(message)
        })
      )
    )
  })

  return { step }
})

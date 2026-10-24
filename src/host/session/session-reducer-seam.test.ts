import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import {
  makeSessionReducer,
  type SessionEventReducer,
  type SessionEventReducerFactory
} from './session-reducer-seam'

const sdk = (message: object): SDKMessage => message as SDKMessage

const init = sdk({ type: 'system', subtype: 'init', session_id: 'session-1' })
const assistantText = (...texts: ReadonlyArray<string>) =>
  sdk({
    type: 'assistant',
    uuid: 'uuid-1',
    message: { content: texts.map((text) => ({ type: 'text', text })) }
  })
const assistantToolUseOnly = sdk({
  type: 'assistant',
  uuid: 'uuid-2',
  message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] }
})
const resultSuccess = sdk({ type: 'result', subtype: 'success' })
const resultError = (...errors: ReadonlyArray<string>) =>
  sdk({ type: 'result', subtype: 'error_max_turns', errors })
const textDelta = sdk({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }
})

const registryProviding = (provided: Option.Option<unknown>) => ({
  inject: (key: string) =>
    Effect.succeed(key === 'sessionReducer' ? provided : Option.none<unknown>())
})

const stepAll = (
  reducer: { readonly step: (message: SDKMessage) => Effect.Effect<ReadonlyArray<unknown>> },
  messages: ReadonlyArray<SDKMessage>
) => Effect.forEach(messages, (message) => reducer.step(message))

describe('makeSessionReducer without a session-reducer plugin', () => {
  const withoutPlugin = makeSessionReducer(registryProviding(Option.none()))

  it.effect('maps init to SessionStarted with the SDK session id', () =>
    Effect.gen(function* () {
      const reducer = yield* withoutPlugin
      assert.deepStrictEqual(yield* reducer.step(init), [
        { _tag: 'SessionStarted', sessionId: 'session-1' }
      ])
    })
  )

  it.effect('maps an assistant message to its joined text', () =>
    Effect.gen(function* () {
      const reducer = yield* withoutPlugin
      assert.deepStrictEqual(yield* reducer.step(assistantText('Hello, ', 'world')), [
        {
          _tag: 'AssistantMessageReceived',
          message: { role: 'assistant', content: 'Hello, world' }
        }
      ])
    })
  )

  it.effect('emits nothing for an assistant message with no text', () =>
    Effect.gen(function* () {
      const reducer = yield* withoutPlugin
      assert.deepStrictEqual(yield* reducer.step(assistantToolUseOnly), [])
    })
  )

  it.effect('maps a successful result to TurnCompleted', () =>
    Effect.gen(function* () {
      const reducer = yield* withoutPlugin
      assert.deepStrictEqual(yield* reducer.step(resultSuccess), [{ _tag: 'TurnCompleted' }])
    })
  )

  it.effect('maps an error result to TurnErrored joining its errors', () =>
    Effect.gen(function* () {
      const reducer = yield* withoutPlugin
      assert.deepStrictEqual(yield* reducer.step(resultError('first', 'second')), [
        { _tag: 'TurnErrored', error: { message: 'first; second' } }
      ])
    })
  )

  it.effect('names the result subtype when an error result lists no errors', () =>
    Effect.gen(function* () {
      const reducer = yield* withoutPlugin
      assert.deepStrictEqual(yield* reducer.step(resultError()), [
        { _tag: 'TurnErrored', error: { message: 'error_max_turns' } }
      ])
    })
  )

  it.effect('emits nothing for a streaming delta, which only the plugin renders', () =>
    Effect.gen(function* () {
      const reducer = yield* withoutPlugin
      assert.deepStrictEqual(yield* reducer.step(textDelta), [])
    })
  )
})

describe('makeSessionReducer with a session-reducer plugin', () => {
  const marker = [{ _tag: 'TurnCompleted' as const }]

  it.effect('uses the factory the plugin provides, creating one reducer per call', () =>
    Effect.gen(function* () {
      let created = 0
      const factory: SessionEventReducerFactory = () => {
        created += 1
        const id = created
        return {
          step: () => [{ _tag: 'SessionStarted' as const, sessionId: `plugin-${id}` }]
        }
      }
      const registry = registryProviding(Option.some(factory))

      const first = yield* makeSessionReducer(registry)
      const second = yield* makeSessionReducer(registry)

      assert.deepStrictEqual(yield* first.step(init), [
        { _tag: 'SessionStarted', sessionId: 'plugin-1' }
      ])
      assert.deepStrictEqual(yield* second.step(init), [
        { _tag: 'SessionStarted', sessionId: 'plugin-2' }
      ])
    })
  )

  it.effect('falls back when the provided value is not a function', () =>
    Effect.gen(function* () {
      const reducer = yield* makeSessionReducer(registryProviding(Option.some('not a factory')))
      assert.deepStrictEqual(yield* reducer.step(resultSuccess), marker)
    })
  )

  it.effect('falls back when the factory throws', () =>
    Effect.gen(function* () {
      const factory: SessionEventReducerFactory = () => {
        throw new Error('factory failed')
      }
      const reducer = yield* makeSessionReducer(registryProviding(Option.some(factory)))
      assert.deepStrictEqual(yield* reducer.step(resultSuccess), marker)
    })
  )

  it.effect('answers the message that made step throw from the fallback', () =>
    Effect.gen(function* () {
      const throwing: SessionEventReducer = {
        step: () => {
          throw new Error('step failed')
        }
      }
      const reducer = yield* makeSessionReducer(registryProviding(Option.some(() => throwing)))
      assert.deepStrictEqual(yield* reducer.step(resultSuccess), marker)
    })
  )

  it.effect('keeps using the fallback after step threw, without calling the plugin again', () =>
    Effect.gen(function* () {
      let calls = 0
      const flaky: SessionEventReducer = {
        step: () => {
          calls += 1
          if (calls === 1) throw new Error('first call fails')
          return [{ _tag: 'SessionStarted' as const, sessionId: 'plugin-recovered' }]
        }
      }
      const reducer = yield* makeSessionReducer(registryProviding(Option.some(() => flaky)))

      const outputs = yield* stepAll(reducer, [init, init])

      assert.deepStrictEqual(outputs, [
        [{ _tag: 'SessionStarted', sessionId: 'session-1' }],
        [{ _tag: 'SessionStarted', sessionId: 'session-1' }]
      ])
      assert.strictEqual(calls, 1)
    })
  )

  it.effect('passes every message to the plugin while it does not throw', () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const recording: SessionEventReducer = {
        step: (message) => {
          seen.push(message.type)
          return []
        }
      }
      const reducer = yield* makeSessionReducer(registryProviding(Option.some(() => recording)))

      yield* stepAll(reducer, [init, textDelta, resultSuccess])

      assert.deepStrictEqual(seen, ['system', 'stream_event', 'result'])
    })
  )
})

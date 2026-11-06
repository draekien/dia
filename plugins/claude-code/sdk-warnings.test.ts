import { EventEmitter } from 'node:events'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Logger } from 'effect'
import { CAN_USE_TOOL_SHADOWED, logShadowedCanUseToolWarnings } from './sdk-warnings'

interface CapturedLog {
  readonly level: string
  readonly text: string
}

const captureLogs = () => {
  const logs: Array<CapturedLog> = []
  const logger = Logger.make(({ message, logLevel }) => {
    logs.push({
      level: logLevel,
      text: (Array.isArray(message) ? message : [message])
        .map((part) => JSON.stringify(part))
        .join(' ')
    })
  })
  return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) }
}

const warning = (code: string, message: string): Error =>
  Object.assign(new Error(message), { name: 'Warning', code })

const SHADOWED_TEXT =
  "canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call"

describe('logShadowedCanUseToolWarnings', () => {
  it.effect('logs a shadowed canUseTool warning at info level with its message', () => {
    const { logs, layer } = captureLogs()
    const emitter = new EventEmitter()
    return Effect.scoped(
      Effect.gen(function* () {
        yield* logShadowedCanUseToolWarnings(emitter)

        emitter.emit('warning', warning(CAN_USE_TOOL_SHADOWED, SHADOWED_TEXT))
        yield* Effect.yieldNow

        assert.strictEqual(logs.length, 1)
        assert.strictEqual(logs[0]?.level, 'Info')
        assert.include(logs[0]?.text, SHADOWED_TEXT)
      })
    ).pipe(Effect.provide(layer))
  })

  it.effect('logs nothing for a warning with another code', () => {
    const { logs, layer } = captureLogs()
    const emitter = new EventEmitter()
    return Effect.scoped(
      Effect.gen(function* () {
        yield* logShadowedCanUseToolWarnings(emitter)

        emitter.emit('warning', warning('DEP0040', 'The punycode module is deprecated.'))
        yield* Effect.yieldNow

        assert.deepStrictEqual(logs, [])
      })
    ).pipe(Effect.provide(layer))
  })

  it.effect('stops listening once its scope closes', () => {
    const { logs, layer } = captureLogs()
    const emitter = new EventEmitter()
    return Effect.gen(function* () {
      yield* Effect.scoped(logShadowedCanUseToolWarnings(emitter))

      emitter.emit('warning', warning(CAN_USE_TOOL_SHADOWED, SHADOWED_TEXT))
      yield* Effect.yieldNow

      assert.strictEqual(emitter.listenerCount('warning'), 0)
      assert.deepStrictEqual(logs, [])
    }).pipe(Effect.provide(layer))
  })
})

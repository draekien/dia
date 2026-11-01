// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test yields to Node's event loop so the plugin's non-Effect callbacks run.
import { setImmediate } from 'node:timers/promises'
import type {
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { OutboundMessage } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import type { PaneConfig } from '@shared/domain/pane'
import { Effect, Option, Queue } from 'effect'
import { vi } from 'vitest'
import { openClaudeCodeSession } from './session'

type Reading = Pick<
  SDKControlGetContextUsageResponse,
  'totalTokens' | 'maxTokens' | 'autoCompactThreshold' | 'isAutoCompactEnabled'
>

const sdk = vi.hoisted(() => ({
  readings: [] as Array<Reading | Error>,
  details: [] as Array<string | undefined>,
  emit: (_message: SDKMessage): void => {}
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  const fakeQuery = ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    const pending = Effect.runSync(Queue.unbounded<SDKMessage | 'end'>())
    sdk.emit = (message) => {
      Queue.offerUnsafe(pending, message)
    }
    void (async () => {
      for await (const _ of prompt) {
      }
    })()
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<SDKMessage>> => {
          const message = await Effect.runPromise(Queue.take(pending))
          return message === 'end'
            ? { done: true, value: undefined }
            : { done: false, value: message }
        },
        return: () => Promise.resolve({ done: true as const, value: undefined })
      }),
      close: () => {
        Queue.offerUnsafe(pending, 'end')
      },
      supportedCommands: () => Promise.resolve([]),
      setPermissionMode: () => Promise.resolve(),
      getContextUsage: (options?: { detail?: string }) => {
        sdk.details.push(options?.detail)
        const next = sdk.readings.shift()
        if (next === undefined) return Promise.reject(new Error('no reading scripted'))
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
      }
    }
  }
  return { ...original, query: fakeQuery }
})

const config: PaneConfig = {
  paneId: '00000000-0000-0000-0000-000000000001',
  cwd: 'F:/Dev/dia-verify/context',
  model: 'claude-sonnet-5',
  thinkingLevel: 'off',
  permissionMode: 'default'
}

const reading = (totalTokens: number): Reading => ({
  totalTokens,
  maxTokens: 200_000,
  autoCompactThreshold: 167_000,
  isAutoCompactEnabled: true
})

const success = { type: 'result', subtype: 'success' } as unknown as SDKMessage

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'manual', pre_tokens: 120_000, post_tokens: 9_000 },
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'test-session'
} as unknown as SDKMessage

const conversationReset = {
  type: 'conversation_reset',
  new_conversation_id: '00000000-0000-0000-0000-000000000002'
} as unknown as SDKMessage

const settle = Effect.gen(function* () {
  for (let tick = 0; tick < 10; tick++) yield* Effect.promise(() => setImmediate())
})

const open = Effect.fnUntraced(function* (readings: ReadonlyArray<Reading | Error>) {
  sdk.readings = [...readings]
  sdk.details = []
  const emitted: Array<OutboundMessage> = []
  yield* openClaudeCodeSession(
    {
      config,
      resume: Option.none(),
      emit: (m) => Effect.sync(() => emitted.push(m)),
      tools: [],
      systemPromptAppend: '',
      pluginPaths: []
    },
    {
      resolve: Effect.succeed(Option.some('/usr/local/bin/claude')),
      override: Effect.succeed(Option.none()),
      setOverride: () => Effect.void
    },
    () => Effect.void
  )
  yield* settle
  const receive = (message: SDKMessage) =>
    Effect.sync(() => sdk.emit(message)).pipe(Effect.andThen(settle))
  const usages = () =>
    emitted.flatMap((m) => (m._tag === 'ContextUsageChanged' ? [m.usage.totalTokens] : []))
  return { emitted, receive, usages }
})

describe('claude-code session context usage', () => {
  it.effect('reports the usage of a newly opened query before its first turn', () =>
    Effect.gen(function* () {
      const { emitted } = yield* open([reading(28_000)])

      const event = emitted.find((m) => m._tag === 'ContextUsageChanged')
      assert.deepStrictEqual(event?._tag === 'ContextUsageChanged' ? event.usage : undefined, {
        totalTokens: 28_000,
        maxTokens: 200_000,
        autoCompactThreshold: 167_000
      })
    }).pipe(Effect.scoped)
  )

  it.effect('reports a summary reading after a turn ends', () =>
    Effect.gen(function* () {
      const { receive, usages } = yield* open([reading(28_000), reading(41_000)])

      yield* receive(success)

      assert.deepStrictEqual(usages(), [28_000, 41_000])
      assert.deepStrictEqual(sdk.details, ['summary', 'summary'])
    }).pipe(Effect.scoped)
  )

  it.effect('reads the full breakdown at the end of a turn that compacted', () =>
    Effect.gen(function* () {
      const { receive, usages } = yield* open([reading(120_000), reading(37_000)])

      yield* receive(compactBoundary)
      yield* receive(success)

      assert.deepStrictEqual(usages(), [120_000, 37_000])
      assert.deepStrictEqual(sdk.details, ['summary', 'full'])
    }).pipe(Effect.scoped)
  )

  it.effect('reads a summary again on the turn after the one that compacted', () =>
    Effect.gen(function* () {
      const { receive } = yield* open([reading(120_000), reading(37_000), reading(38_000)])

      yield* receive(compactBoundary)
      yield* receive(success)
      yield* receive(success)

      assert.deepStrictEqual(sdk.details, ['summary', 'full', 'summary'])
    }).pipe(Effect.scoped)
  )

  it.effect('reads the full breakdown right after the conversation is reset', () =>
    Effect.gen(function* () {
      const { receive, usages } = yield* open([reading(60_000), reading(25_000)])

      yield* receive(conversationReset)

      assert.deepStrictEqual(usages(), [60_000, 25_000])
      assert.deepStrictEqual(sdk.details, ['summary', 'full'])
    }).pipe(Effect.scoped)
  )

  it.effect('reports the reading after the turn end it follows', () =>
    Effect.gen(function* () {
      const { emitted, receive } = yield* open([reading(28_000), reading(41_000)])

      yield* receive(success)

      const tags = emitted.map((m) => m._tag)
      assert.isBelow(tags.indexOf('TurnCompleted'), tags.lastIndexOf('ContextUsageChanged'))
    }).pipe(Effect.scoped)
  )

  it.effect('emits nothing for a failed read and reports the next one that succeeds', () =>
    Effect.gen(function* () {
      const { emitted, receive, usages } = yield* open([
        new Error('control request failed'),
        reading(41_000)
      ])

      assert.deepStrictEqual(usages(), [])
      yield* receive(success)

      assert.deepStrictEqual(usages(), [41_000])
      assert.isTrue(emitted.some((m) => m._tag === 'TurnCompleted'))
    }).pipe(Effect.scoped)
  )
})

import { setImmediate } from 'node:timers/promises'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { OutboundMessage } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import type { PaneConfig } from '@shared/domain/pane'
import { Effect, Option, Queue } from 'effect'
import { vi } from 'vitest'
import { openClaudeCodeSession } from './session'

interface FakeQuery {
  readonly options: Options
  readonly delivered: Array<SDKUserMessage>
  interrupts: number
  readonly emit: (message: SDKMessage | 'end') => void
}

const sdk = vi.hoisted(() => ({ queries: [] as Array<FakeQuery> }))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  const fakeQuery = ({
    prompt,
    options
  }: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }) => {
    const pending = Effect.runSync(Queue.unbounded<SDKMessage | 'end'>())
    const record: FakeQuery = {
      options,
      delivered: [],
      interrupts: 0,
      emit: (message) => {
        Queue.offerUnsafe(pending, message)
      }
    }
    sdk.queries.push(record)
    let closed = false
    void (async () => {
      for await (const message of prompt) {
        if (closed) break
        record.delivered.push(message)
      }
    })()
    const next = async (): Promise<IteratorResult<SDKMessage>> => {
      const message = await Effect.runPromise(Queue.take(pending))
      if (closed || message === 'end') return { done: true, value: undefined }
      return { done: false, value: message }
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next,
        return: () => Promise.resolve({ done: true as const, value: undefined })
      }),
      close: () => {
        closed = true
        Queue.offerUnsafe(pending, 'end')
      },
      supportedCommands: () => Promise.resolve([]),
      rewindFiles: () => Promise.resolve({ canRewind: true, filesChanged: [] }),
      interrupt: () => {
        record.interrupts += 1
        return Promise.resolve()
      },
      setPermissionMode: () => Promise.resolve()
    }
  }
  return { ...original, query: fakeQuery }
})

const config: PaneConfig = {
  paneId: '00000000-0000-0000-0000-000000000001',
  cwd: 'F:/Dev/dia-verify/queue',
  model: 'claude-sonnet-5',
  thinkingLevel: 'off',
  permissionMode: 'default'
}

const success = { type: 'result', subtype: 'success' } as unknown as SDKMessage
const aborted = {
  type: 'result',
  subtype: 'error_during_execution',
  errors: ['aborted']
} as unknown as SDKMessage

const settle = Effect.gen(function* () {
  for (let tick = 0; tick < 10; tick++) yield* Effect.promise(() => setImmediate())
})

const open = Effect.gen(function* () {
  sdk.queries.length = 0
  const emitted: Array<OutboundMessage> = []
  const session = yield* openClaudeCodeSession({
    config,
    resume: Option.none(),
    emit: (message) => Effect.sync(() => emitted.push(message)),
    tools: []
  })
  const query = sdk.queries[0]
  assert.isDefined(query)
  const endTurn = (result: SDKMessage = success) =>
    Effect.sync(() => query.emit(result)).pipe(Effect.andThen(settle))
  return { session, emitted, query, endTurn }
})

const texts = (query: FakeQuery) => query.delivered.map((message) => message.message.content)

const tags = (emitted: ReadonlyArray<OutboundMessage>) =>
  emitted.map((message) => message._tag).filter((tag) => !tag.startsWith('SlashCommands'))

const lastQueue = (emitted: ReadonlyArray<OutboundMessage>) =>
  emitted.filter((message) => message._tag === 'MessageQueueChanged').at(-1)

describe('message queue', () => {
  it.effect('sends a message at once when no turn is running', () =>
    Effect.gen(function* () {
      const { session, emitted, query } = yield* open

      yield* session.sendText('first', 'queue')
      yield* settle

      assert.deepStrictEqual(texts(query), ['first'])
      assert.deepStrictEqual(tags(emitted), ['UserMessagesSent'])
    })
  )

  it.effect('holds a queued message while the turn runs, without interrupting it', () =>
    Effect.gen(function* () {
      const { session, emitted, query } = yield* open
      yield* session.sendText('first', 'queue')

      yield* session.sendText('second', 'queue')
      yield* settle

      assert.deepStrictEqual(texts(query), ['first'])
      assert.strictEqual(query.interrupts, 0)
      const queue = lastQueue(emitted)
      assert.deepStrictEqual(
        queue?._tag === 'MessageQueueChanged' ? queue.queued.map((m) => m.text) : [],
        ['second']
      )
    })
  )

  it.effect('sends every queued message as one turn when the turn ends', () =>
    Effect.gen(function* () {
      const { session, emitted, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('second', 'queue')
      yield* session.sendText('third', 'queue')

      yield* endTurn()

      assert.deepStrictEqual(texts(query), ['first', 'second', 'third'])
      assert.deepStrictEqual(
        query.delivered.map((message) => message.shouldQuery),
        [undefined, false, undefined]
      )
      assert.deepStrictEqual(tags(emitted).slice(-3), [
        'TurnCompleted',
        'MessageQueueChanged',
        'UserMessagesSent'
      ])
    })
  )

  it.effect('does not report the result of a message that starts no turn as a turn end', () =>
    Effect.gen(function* () {
      const { session, emitted, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('second', 'queue')
      yield* session.sendText('third', 'queue')
      yield* endTurn()
      const turnEnds = () => tags(emitted).filter((tag) => tag === 'TurnCompleted').length

      yield* endTurn()
      assert.strictEqual(turnEnds(), 1)

      yield* endTurn()
      assert.strictEqual(turnEnds(), 2)
      yield* session.sendText('fourth', 'queue')
      yield* settle
      assert.deepStrictEqual(texts(query).at(-1), 'fourth')
    })
  )

  it.effect('sends the edited text of a queued message and never a removed one', () =>
    Effect.gen(function* () {
      const { session, emitted, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('second', 'queue')
      yield* session.sendText('third', 'queue')
      const queue = lastQueue(emitted)
      assert.isTrue(queue?._tag === 'MessageQueueChanged')
      const [second, third] = queue?._tag === 'MessageQueueChanged' ? queue.queued : []

      yield* session.editQueuedText(second.id, 'second, edited')
      yield* session.removeQueuedText(third.id)
      yield* endTurn()

      assert.deepStrictEqual(texts(query), ['first', 'second, edited'])
    })
  )

  it.effect('steers: interrupts once, ends the turn cleanly and sends the steer alone', () =>
    Effect.gen(function* () {
      const { session, emitted, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('queued', 'queue')

      yield* session.sendText('steer', 'steer')
      yield* settle
      assert.strictEqual(query.interrupts, 1)
      assert.deepStrictEqual(texts(query), ['first'])

      yield* endTurn(aborted)
      assert.isFalse(tags(emitted).includes('TurnErrored'))
      assert.deepStrictEqual(texts(query), ['first', 'steer'])

      yield* endTurn()
      assert.deepStrictEqual(texts(query), ['first', 'steer', 'queued'])
    })
  )

  it.effect('suppresses a steered abort that follows the result of a silent message', () =>
    Effect.gen(function* () {
      const { session, emitted, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('second', 'queue')
      yield* session.sendText('third', 'queue')
      yield* endTurn()

      yield* session.sendText('steer', 'steer')
      yield* endTurn()
      yield* endTurn(aborted)

      assert.isFalse(tags(emitted).includes('TurnErrored'))
    })
  )

  it.effect('holds the queue after a stop and sends it ahead of the next message', () =>
    Effect.gen(function* () {
      const { session, emitted, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('queued', 'queue')

      yield* session.interrupt()
      yield* endTurn(aborted)
      assert.deepStrictEqual(texts(query), ['first'])
      const queue = lastQueue(emitted)
      assert.isTrue(queue?._tag === 'MessageQueueChanged' && queue.held)

      yield* session.sendText('next', 'queue')
      yield* settle
      assert.deepStrictEqual(texts(query), ['first', 'queued', 'next'])
    })
  )

  it.effect('holds the queue after a failed turn', () =>
    Effect.gen(function* () {
      const { session, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('queued', 'queue')

      yield* endTurn(aborted)

      assert.deepStrictEqual(texts(query), ['first'])
      assert.deepStrictEqual((yield* session.messageQueue).held, true)
    })
  )

  it.effect('empties the queue when the session ends', () =>
    Effect.gen(function* () {
      const { session, emitted, query } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('queued', 'queue')

      query.emit('end')
      yield* settle

      const queue = lastQueue(emitted)
      assert.isTrue(queue?._tag === 'MessageQueueChanged' && queue.queued.length === 0)
      assert.deepStrictEqual((yield* session.messageQueue).queued, [])
    })
  )
})

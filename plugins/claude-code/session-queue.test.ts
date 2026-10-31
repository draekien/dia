// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test yields to Node's event loop so the plugin's non-Effect callbacks run.
import { setImmediate } from 'node:timers/promises'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { type OutboundMessage, SessionFailed, SessionNotFound } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import type { PaneConfig, SessionId } from '@shared/domain/pane'
import { Effect, Option, Queue } from 'effect'
import { vi } from 'vitest'
import {
  type ClaudeInstall,
  NOT_INSTALLED_REASON,
  overrideUnrunnableReason
} from './claude-install'
import { openClaudeCodeSession } from './session'

interface FakeQuery {
  readonly options: Options
  readonly delivered: Array<SDKUserMessage>
  interrupts: number
  readonly models: Array<string | undefined>
  readonly emit: (message: SDKMessage | 'end') => void
  readonly fail: (error: Error) => void
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
    const pending = Effect.runSync(Queue.unbounded<SDKMessage | 'end' | Error>())
    const record: FakeQuery = {
      options,
      delivered: [],
      interrupts: 0,
      models: [],
      emit: (message) => {
        Queue.offerUnsafe(pending, message)
      },
      fail: (error) => {
        Queue.offerUnsafe(pending, error)
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
      if (message instanceof Error) throw message
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
      setPermissionMode: () => Promise.resolve(),
      setModel: (model?: string) => {
        record.models.push(model)
        return Promise.resolve()
      }
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

const INSTALL_PATH = '/usr/local/bin/claude'

const installAt = (
  resolved: Option.Option<string>,
  override: Option.Option<string> = Option.none()
): ClaudeInstall => ({
  resolve: Effect.succeed(resolved),
  override: Effect.succeed(override),
  setOverride: () => Effect.void
})

const openWith = Effect.fnUntraced(function* (resume: Option.Option<SessionId>) {
  sdk.queries.length = 0
  const emitted: Array<OutboundMessage> = []
  const startupFailures: Array<string> = []
  const session = yield* openClaudeCodeSession(
    {
      config,
      resume,
      emit: (message) => Effect.sync(() => emitted.push(message)),
      tools: []
    },
    installAt(Option.some(INSTALL_PATH)),
    (reason) => Effect.sync(() => startupFailures.push(reason))
  )
  const query = sdk.queries[0]
  assert.isDefined(query)
  const endTurn = (result: SDKMessage = success) =>
    Effect.sync(() => query.emit(result)).pipe(Effect.andThen(settle))
  return { session, emitted, query, endTurn, startupFailures }
})

const open = openWith(Option.none())

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

  it.effect('sends the queue once the stopped turn ends', () =>
    Effect.gen(function* () {
      const { session, emitted, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('queued', 'queue')

      yield* session.interrupt()
      yield* settle
      assert.deepStrictEqual(texts(query), ['first'])
      yield* endTurn(aborted)

      assert.isFalse(tags(emitted).includes('TurnErrored'))
      assert.deepStrictEqual(texts(query), ['first', 'queued'])
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

describe('model change', () => {
  it.effect('applies a new model when the next turn is sent and marks it before that turn', () =>
    Effect.gen(function* () {
      const { session, emitted, query } = yield* open

      yield* session.setModel('claude-opus-5')
      yield* session.sendText('first', 'queue')
      yield* settle

      assert.deepStrictEqual(query.models, ['claude-opus-5'])
      assert.deepStrictEqual(tags(emitted), ['ModelChanged', 'UserMessagesSent'])
    })
  )

  it.effect('lets a running turn finish on its model and switches at the next turn', () =>
    Effect.gen(function* () {
      const { session, emitted, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* settle

      yield* session.setModel('claude-opus-5')
      yield* settle
      const modelsDuringTurn = [...query.models]
      yield* endTurn()
      yield* session.sendText('second', 'queue')
      yield* settle

      assert.deepStrictEqual(modelsDuringTurn, [])
      assert.deepStrictEqual(query.models, ['claude-opus-5'])
      assert.deepStrictEqual(tags(emitted), [
        'UserMessagesSent',
        'TurnCompleted',
        'ModelChanged',
        'UserMessagesSent'
      ])
    })
  )

  it.effect('does nothing when the chosen model is the one in use', () =>
    Effect.gen(function* () {
      const { session, emitted, query } = yield* open

      yield* session.setModel(config.model)
      yield* session.sendText('first', 'queue')
      yield* settle

      assert.deepStrictEqual(query.models, [])
      assert.deepStrictEqual(tags(emitted), ['UserMessagesSent'])
    })
  )

  it.effect('applies a model once, not again on the turn after', () =>
    Effect.gen(function* () {
      const { session, query, endTurn } = yield* open
      yield* session.setModel('claude-opus-5')
      yield* session.sendText('first', 'queue')
      yield* settle
      yield* endTurn()

      yield* session.sendText('second', 'queue')
      yield* settle

      assert.deepStrictEqual(query.models, ['claude-opus-5'])
    })
  )
})

describe('install', () => {
  it.effect('starts its query on the resolved install path', () =>
    Effect.gen(function* () {
      const { query } = yield* open

      assert.strictEqual(query.options.pathToClaudeCodeExecutable, INSTALL_PATH)
      assert.strictEqual(query.options.env?.CLAUDE_CODE_STARTUP_FAILURE_RESULTS, '1')
    })
  )

  it.effect('reports a known startup failure from the result', () =>
    Effect.gen(function* () {
      const { session, endTurn, startupFailures } = yield* open
      yield* session.sendText('first', 'queue')
      yield* settle

      yield* endTurn({
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['Claude Code is too old'],
        startup_failure_reason: 'cli_version_too_old'
      } as unknown as SDKMessage)

      assert.deepStrictEqual(startupFailures, ['cli_version_too_old'])
    })
  )

  it.effect('ends at once without a query when no install is found', () =>
    Effect.gen(function* () {
      sdk.queries.length = 0
      const session = yield* openClaudeCodeSession(
        { config, resume: Option.none(), emit: () => Effect.void, tools: [] },
        installAt(Option.none()),
        () => Effect.void
      )

      assert.deepStrictEqual(
        yield* session.ended,
        SessionFailed.make({ reason: NOT_INSTALLED_REASON })
      )
      assert.strictEqual(sdk.queries.length, 0)
    })
  )

  it.effect('names the stored override when it cannot be run', () =>
    Effect.gen(function* () {
      const session = yield* openClaudeCodeSession(
        { config, resume: Option.none(), emit: () => Effect.void, tools: [] },
        installAt(Option.none(), Option.some('D:\\claude.cmd')),
        () => Effect.void
      )

      assert.deepStrictEqual(
        yield* session.ended,
        SessionFailed.make({ reason: overrideUnrunnableReason('D:\\claude.cmd') })
      )
    })
  )
})

describe('parked turn', () => {
  const rejected = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1_700_000_000 }
  } as unknown as SDKMessage

  const refuseTurn = (query: FakeQuery) => Effect.sync(() => query.emit(rejected))

  it.effect('ends a refused turn as parked and holds the queue', () =>
    Effect.gen(function* () {
      const { session, emitted, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('queued', 'queue')

      yield* refuseTurn(query)
      yield* endTurn(aborted)

      assert.isTrue(tags(emitted).includes('TurnParked'))
      assert.isFalse(tags(emitted).includes('TurnErrored'))
      assert.deepStrictEqual(texts(query), ['first'])
      assert.deepStrictEqual((yield* session.messageQueue).held, true)
    })
  )

  it.effect('resumes with continue first and sends the held queue after that turn', () =>
    Effect.gen(function* () {
      const { session, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')
      yield* session.sendText('queued', 'queue')
      yield* refuseTurn(query)
      yield* endTurn(aborted)

      yield* session.resume
      yield* settle
      assert.deepStrictEqual(texts(query), ['first', 'continue'])

      yield* endTurn()
      assert.deepStrictEqual(texts(query), ['first', 'continue', 'queued'])
    })
  )

  it.effect('ignores a resume while a turn is running', () =>
    Effect.gen(function* () {
      const { session, query } = yield* open
      yield* session.sendText('first', 'queue')

      yield* session.resume
      yield* settle

      assert.deepStrictEqual(texts(query), ['first'])
    })
  )

  it.effect('ends a refused turn the user stopped as a clean turn end', () =>
    Effect.gen(function* () {
      const { session, emitted, query, endTurn } = yield* open
      yield* session.sendText('first', 'queue')

      yield* session.interrupt()
      yield* refuseTurn(query)
      yield* endTurn(aborted)

      assert.isFalse(tags(emitted).includes('TurnParked'))
      assert.isTrue(tags(emitted).includes('TurnCompleted'))
    })
  )
})

describe('missing session', () => {
  const missingId = '9c376084-48c1-4e74-b886-7915ef2993db' as SessionId
  const notFound = (turns = 0) =>
    ({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: turns,
      errors: [`No conversation found with session ID: ${missingId}`]
    }) as unknown as SDKMessage
  const thrown = new Error(
    `Claude Code returned an error result: No conversation found with session ID: ${missingId}`
  )

  it.effect('ends as not found, without a turn error, when the resumed conversation is gone', () =>
    Effect.gen(function* () {
      const { session, emitted, query } = yield* openWith(Option.some(missingId))

      query.emit(notFound())
      query.fail(thrown)

      assert.deepStrictEqual(yield* session.ended, SessionNotFound.make({ sessionId: missingId }))
      assert.isFalse(tags(emitted).includes('TurnErrored'))
    })
  )

  it.effect('ends as not found when the stream completes after the not-found result', () =>
    Effect.gen(function* () {
      const { session, query } = yield* openWith(Option.some(missingId))

      query.emit(notFound())
      query.emit('end')

      assert.deepStrictEqual(yield* session.ended, SessionNotFound.make({ sessionId: missingId }))
    })
  )

  it.effect('ends as failed, with a turn error, when the session was not resumed', () =>
    Effect.gen(function* () {
      const { session, emitted, query } = yield* open

      query.emit(notFound())
      query.fail(thrown)

      assert.strictEqual((yield* session.ended)._tag, 'SessionFailed')
      assert.isTrue(tags(emitted).includes('TurnErrored'))
    })
  )

  it.effect('ends as failed, with a turn error, when the result ran a turn', () =>
    Effect.gen(function* () {
      const { session, emitted, query } = yield* openWith(Option.some(missingId))

      query.emit(notFound(1))
      query.fail(thrown)

      assert.strictEqual((yield* session.ended)._tag, 'SessionFailed')
      assert.isTrue(tags(emitted).includes('TurnErrored'))
    })
  )

  it.effect('ends as failed with the rendered error for any other failure', () =>
    Effect.gen(function* () {
      const { session, query } = yield* openWith(Option.some(missingId))

      query.fail(new Error('socket closed'))

      const end = yield* session.ended
      assert.strictEqual(end._tag, 'SessionFailed')
      assert.include(end._tag === 'SessionFailed' ? end.reason : '', 'Error: socket closed')
    })
  )

  it.effect(
    'ends as not found when a thinking-level restart resumes a conversation that is gone',
    () =>
      Effect.gen(function* () {
        const { session } = yield* openWith(Option.some(missingId))
        yield* session.setThinkingLevel('high')
        yield* session.sendText('first', 'queue')
        yield* settle
        const restarted = sdk.queries[1]
        assert.isDefined(restarted)
        assert.strictEqual(restarted.options.resume, missingId)

        restarted.emit(notFound())
        restarted.fail(thrown)

        assert.deepStrictEqual(yield* session.ended, SessionNotFound.make({ sessionId: missingId }))
      })
  )

  it.effect(
    'ends as failed, with a turn error, when a rewind reports the conversation not found',
    () =>
      Effect.gen(function* () {
        const { session, emitted } = yield* openWith(Option.some(missingId))
        yield* session.rewindToCheckpoint('turn-2', 'reply-1')
        const forked = sdk.queries[1]
        assert.isDefined(forked)
        assert.strictEqual(forked.options.resumeSessionAt, 'reply-1')

        forked.emit(notFound())
        forked.fail(thrown)

        assert.strictEqual((yield* session.ended)._tag, 'SessionFailed')
        assert.isTrue(tags(emitted).includes('TurnErrored'))
      })
  )
})

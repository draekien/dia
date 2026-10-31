// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test yields to Node's event loop so the plugin's non-Effect callbacks run.
import { setImmediate } from 'node:timers/promises'
import type { Options, SDKUserMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { type AgentSessionOptions, type OutboundMessage, RewindFailed } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import type { PaneConfig, SessionId } from '@shared/domain/pane'
import { Deferred, Duration, Effect, Fiber, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { vi } from 'vitest'
import type { ClaudeInstall } from './claude-install'
import { openClaudeCodeSession } from './session'

const installed: ClaudeInstall = {
  resolve: Effect.succeed(Option.some('/usr/local/bin/claude')),
  override: Effect.succeed(Option.none()),
  setOverride: () => Effect.void
}

const openSession = (options: AgentSessionOptions) =>
  openClaudeCodeSession(options, installed, () => Effect.void)

interface FakeQuery {
  readonly options: Options
  readonly delivered: Array<string>
  readonly rewound: Array<string>
  closed: boolean
}

const sdk = vi.hoisted(() => ({
  queries: [] as Array<FakeQuery>,
  log: [] as Array<string>,
  transcript: { messages: [] as Array<SessionMessage>, fails: false },
  rewindGate: (): Promise<void> => Promise.resolve(),
  rewindResult: { canRewind: true } as { canRewind: boolean; error?: string }
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  const { Deferred, Effect } = await import('effect')
  const fakeQuery = ({
    prompt,
    options
  }: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }) => {
    const index = sdk.queries.length
    const record: FakeQuery = { options, delivered: [], rewound: [], closed: false }
    sdk.queries.push(record)
    const closedSignal = Effect.runSync(Deferred.make<void>())
    void (async () => {
      for await (const message of prompt) {
        if (record.closed) break
        const text = String(message.message.content)
        record.delivered.push(text)
        sdk.log.push(`query ${index} received ${text}`)
      }
    })()
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Effect.runPromise(
            Deferred.await(closedSignal).pipe(Effect.as({ done: true as const, value: undefined }))
          ),
        return: () => Promise.resolve({ done: true as const, value: undefined })
      }),
      close: () => {
        record.closed = true
        Effect.runSync(Deferred.succeed(closedSignal, undefined))
      },
      supportedCommands: () => Promise.resolve([]),
      rewindFiles: async (messageUuid: string) => {
        record.rewound.push(messageUuid)
        await sdk.rewindGate()
        return { ...sdk.rewindResult, filesChanged: [] }
      },
      interrupt: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve()
    }
  }
  return {
    ...original,
    query: fakeQuery,
    getSessionMessages: () =>
      sdk.transcript.fails
        ? Promise.reject(new Error('transcript unreadable'))
        : Promise.resolve(sdk.transcript.messages)
  }
})

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001' as SessionId
const config: PaneConfig = {
  paneId: '00000000-0000-0000-0000-000000000001',
  cwd: 'F:/Dev/dia-verify/rewind',
  model: 'claude-sonnet-5',
  thinkingLevel: 'off',
  permissionMode: 'default'
}

const transcriptMessage = (role: 'user' | 'assistant', uuid: string): SessionMessage => ({
  type: role,
  uuid,
  session_id: SESSION,
  message:
    role === 'user'
      ? { role, content: `${uuid} prompt` }
      : { role, content: [{ type: 'text', text: `${uuid} reply` }] },
  parent_tool_use_id: null,
  parent_agent_id: null
})

const twoTurns = [
  transcriptMessage('user', 'turn-1'),
  transcriptMessage('assistant', 'reply-1'),
  transcriptMessage('user', 'turn-2'),
  transcriptMessage('assistant', 'reply-2')
]

const settle = Effect.gen(function* () {
  for (let tick = 0; tick < 5; tick++) yield* Effect.promise(() => setImmediate())
})

const openResumed = (transcript: ReadonlyArray<SessionMessage>, transcriptFails = false) =>
  Effect.gen(function* () {
    sdk.queries.length = 0
    sdk.log.length = 0
    sdk.transcript.messages = [...transcript]
    sdk.transcript.fails = transcriptFails
    sdk.rewindGate = () => Promise.resolve()
    sdk.rewindResult = { canRewind: true }
    const emitted: Array<OutboundMessage> = []
    const emit = (message: OutboundMessage) =>
      Effect.sync(() => {
        emitted.push(message)
        if (message._tag === 'RewoundToCheckpoint') sdk.log.push(`rewound ${message.messageUuid}`)
      })
    const session = yield* openSession({
      config,
      resume: Option.some(SESSION),
      emit,
      tools: []
    })
    yield* settle
    return { session, emitted }
  })

const rewindFailures = (emitted: ReadonlyArray<OutboundMessage>) =>
  emitted.filter((message) => message._tag === 'RewindFailed')

const queryAt = (index: number): FakeQuery => {
  const query = sdk.queries[index]
  assert.isDefined(query)
  return query
}

const TASK_TRACKING_TOOLS = ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']

describe('task-tracking tools', () => {
  it.effect('names the task tools in the first query so newer models keep them', () =>
    Effect.gen(function* () {
      yield* openResumed(twoTurns)

      assert.includeMembers(queryAt(0).options.allowedTools ?? [], TASK_TRACKING_TOOLS)
    })
  )

  it.effect('names the task tools in the query a rewind forks', () =>
    Effect.gen(function* () {
      const { session } = yield* openResumed(twoTurns)

      yield* session.rewindToCheckpoint('turn-2', 'reply-1')
      yield* settle

      assert.includeMembers(queryAt(1).options.allowedTools ?? [], TASK_TRACKING_TOOLS)
    })
  )
})

describe('rewindToCheckpoint', () => {
  it.effect('rewinds a resumed session before any prompt is sent to it', () =>
    Effect.gen(function* () {
      const { session } = yield* openResumed(twoTurns)

      yield* session.rewindToCheckpoint('turn-2', 'reply-1')
      yield* settle

      assert.deepStrictEqual(queryAt(0).rewound, ['turn-2'])
      assert.strictEqual(queryAt(1).options.resume, SESSION)
      assert.strictEqual(queryAt(1).options.resumeSessionAt, 'reply-1')
      assert.isTrue(queryAt(1).options.forkSession)
    })
  )

  it.effect('rewinds a session as soon as it has opened', () =>
    Effect.gen(function* () {
      sdk.queries.length = 0
      sdk.transcript.messages = [...twoTurns]
      sdk.transcript.fails = false
      sdk.rewindGate = () => Promise.resolve()
      const session = yield* openSession({
        config,
        resume: Option.some(SESSION),
        emit: () => Effect.void,
        tools: []
      })

      yield* session.rewindToCheckpoint('turn-2', 'reply-1')

      assert.deepStrictEqual(queryAt(0).rewound, ['turn-2'])
    })
  )

  it.effect('holds a prompt sent while files rewind until the forked query reads it', () =>
    Effect.gen(function* () {
      const { session } = yield* openResumed(twoTurns)
      const rewindReleased = yield* Deferred.make<void>()
      sdk.rewindGate = () => Effect.runPromise(Deferred.await(rewindReleased))

      const rewind = yield* Effect.forkChild(session.rewindToCheckpoint('turn-2', 'reply-1'))
      yield* settle
      const send = yield* Effect.forkChild(session.sendText('sent during rewind', 'queue'))
      yield* settle
      yield* Deferred.succeed(rewindReleased, undefined)
      yield* Fiber.join(rewind)
      yield* Fiber.join(send)
      yield* settle

      assert.deepStrictEqual(sdk.log, ['rewound turn-2', 'query 1 received sent during rewind'])
    })
  )

  it.effect('keeps the fork point when the thinking level changes before the fork is used', () =>
    Effect.gen(function* () {
      const { session } = yield* openResumed(twoTurns)
      yield* session.rewindToCheckpoint('turn-2', 'reply-1')

      yield* session.setThinkingLevel('high')
      yield* session.sendText('after thinking change', 'queue')
      yield* settle

      assert.strictEqual(queryAt(2).options.resume, SESSION)
      assert.strictEqual(queryAt(2).options.resumeSessionAt, 'reply-1')
      assert.isTrue(queryAt(2).options.forkSession)
    })
  )

  it.effect(
    'gives up a rewind whose files never finish rewinding, so prompts reach the session',
    () =>
      Effect.gen(function* () {
        const { session, emitted } = yield* openResumed(twoTurns)
        sdk.rewindGate = () => Effect.runPromise(Effect.never)

        const rewind = yield* Effect.forkChild(session.rewindToCheckpoint('turn-2', 'reply-1'))
        yield* settle
        yield* TestClock.adjust(Duration.seconds(30))
        yield* Fiber.join(rewind)
        yield* session.sendText('after timeout', 'queue')
        yield* settle

        assert.deepStrictEqual(queryAt(0).delivered, ['after timeout'])
        assert.strictEqual(sdk.queries.length, 1)
        assert.isFalse(emitted.some((message) => message._tag === 'RewoundToCheckpoint'))
        assert.deepStrictEqual(rewindFailures(emitted), [
          RewindFailed.make({ messageUuid: 'turn-2', cause: 'FilesNotRewound' })
        ])
      })
  )

  it.effect('resumes from the assistant message before an anchorless turn', () =>
    Effect.gen(function* () {
      const { session } = yield* openResumed(twoTurns)

      yield* session.rewindToCheckpoint('turn-2', undefined)
      yield* settle

      assert.strictEqual(queryAt(1).options.resume, SESSION)
      assert.strictEqual(queryAt(1).options.resumeSessionAt, 'reply-1')
    })
  )

  it.effect('starts a new conversation when the anchorless turn is the first', () =>
    Effect.gen(function* () {
      const { session, emitted } = yield* openResumed(twoTurns)

      yield* session.rewindToCheckpoint('turn-1', undefined)
      yield* settle

      assert.deepStrictEqual(queryAt(0).rewound, ['turn-1'])
      assert.isUndefined(queryAt(1).options.resume)
      assert.isTrue(emitted.some((message) => message._tag === 'RewoundToCheckpoint'))
    })
  )

  it.effect('keeps the files and the session when an anchorless turn cannot be found', () =>
    Effect.gen(function* () {
      const { session, emitted } = yield* openResumed(twoTurns, true)

      yield* session.rewindToCheckpoint('turn-2', undefined)
      yield* settle

      assert.deepStrictEqual(queryAt(0).rewound, [])
      assert.strictEqual(sdk.queries.length, 1)
      assert.isFalse(emitted.some((message) => message._tag === 'RewoundToCheckpoint'))
      assert.deepStrictEqual(rewindFailures(emitted), [
        RewindFailed.make({ messageUuid: 'turn-2', cause: 'TurnNotInTranscript' })
      ])
    })
  )

  it.effect('reports the SDK reason when the files cannot be rewound', () =>
    Effect.gen(function* () {
      const { session, emitted } = yield* openResumed(twoTurns)
      sdk.rewindResult = { canRewind: false, error: 'No file checkpoint found for this message.' }

      yield* session.rewindToCheckpoint('turn-2', 'reply-1')
      yield* settle

      assert.strictEqual(sdk.queries.length, 1)
      assert.deepStrictEqual(rewindFailures(emitted), [
        RewindFailed.make({
          messageUuid: 'turn-2',
          cause: 'FilesNotRewound',
          detail: 'No file checkpoint found for this message.'
        })
      ])
    })
  )

  it.effect('reports a rewind sent before the session has an id', () =>
    Effect.gen(function* () {
      sdk.queries.length = 0
      const emitted: Array<OutboundMessage> = []
      const session = yield* openSession({
        config,
        resume: Option.none(),
        emit: (message) => Effect.sync(() => emitted.push(message)),
        tools: []
      })

      yield* session.rewindToCheckpoint('turn-2', 'reply-1')

      assert.deepStrictEqual(rewindFailures(emitted), [
        RewindFailed.make({ messageUuid: 'turn-2', cause: 'NoLiveSession' })
      ])
    })
  )

  it.effect('reports a rewind interrupted before the files were rewound', () =>
    Effect.gen(function* () {
      const { session, emitted } = yield* openResumed(twoTurns)
      sdk.rewindGate = () => Effect.runPromise(Effect.never)

      const rewind = yield* Effect.forkChild(session.rewindToCheckpoint('turn-2', 'reply-1'))
      yield* settle
      yield* Fiber.interrupt(rewind)

      assert.deepStrictEqual(rewindFailures(emitted), [
        RewindFailed.make({ messageUuid: 'turn-2', cause: 'Interrupted' })
      ])
    })
  )

  it.effect('reports a rewind stopped after the files were rewound', () =>
    Effect.gen(function* () {
      sdk.queries.length = 0
      sdk.transcript.messages = [...twoTurns]
      sdk.transcript.fails = false
      sdk.rewindGate = () => Promise.resolve()
      sdk.rewindResult = { canRewind: true }
      const emitted: Array<OutboundMessage> = []
      const session = yield* openSession({
        config,
        resume: Option.some(SESSION),
        emit: (message) =>
          message._tag === 'RewoundToCheckpoint'
            ? Effect.never
            : Effect.sync(() => emitted.push(message)),
        tools: []
      })
      yield* settle

      const rewind = yield* Effect.forkChild(session.rewindToCheckpoint('turn-2', 'reply-1'))
      yield* settle
      yield* Fiber.interrupt(rewind)

      assert.deepStrictEqual(queryAt(0).rewound, ['turn-2'])
      assert.deepStrictEqual(rewindFailures(emitted), [
        RewindFailed.make({ messageUuid: 'turn-2', cause: 'ConversationNotBranched' })
      ])
    })
  )

  it.effect('reports no failure for a rewind that completed', () =>
    Effect.gen(function* () {
      const { session, emitted } = yield* openResumed(twoTurns)

      yield* session.rewindToCheckpoint('turn-2', 'reply-1')
      yield* settle

      assert.isTrue(emitted.some((message) => message._tag === 'RewoundToCheckpoint'))
      assert.deepStrictEqual(rewindFailures(emitted), [])
    })
  )
})

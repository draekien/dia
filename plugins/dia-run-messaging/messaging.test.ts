import {
  AgentEvents,
  Attention,
  type CommittedEvent,
  type DiaTool,
  type DiaToolResult,
  PaneChat,
  PaneEvents,
  type RunEvents,
  type RunInfo,
  type Runs,
  type StartRunOptions,
  type StoredEvent,
  type ToolScope
} from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Fiber, Option, PubSub, Queue, Ref, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { makeMessagingTools } from './messaging'

const RUN_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const RUN_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const ARCHIVED = 'cccccccc-0000-4000-8000-000000000003'
const STOPPED = 'dddddddd-0000-4000-8000-000000000004'

const scopeOf = (runId: string): ToolScope => ({ runId, labels: [], context: undefined })

const info = (runId: string, overrides: Partial<RunInfo> = {}): RunInfo => ({
  runId,
  cwd: `/repo/${runId}`,
  model: 'opus',
  thinkingLevel: 'high',
  permissionMode: 'acceptEdits',
  sessionId: Option.none(),
  status: 'idle',
  live: true,
  ...overrides
})

interface Sent {
  readonly runId: string
  readonly text: string
  readonly mode: string
}

const userMessage = (text: string): PaneChat.PaneMessage => ({
  id: `user-${text}`,
  role: 'user',
  parts: [{ type: 'text', content: text }]
})

const assistantMessage = (text: string): PaneChat.PaneMessage => ({
  id: `assistant-${text}`,
  role: 'assistant',
  parts: [{ type: 'text', content: text }]
})

const stateWith = (overrides: Partial<PaneChat.PaneChatState>): PaneChat.PaneChatState => ({
  ...PaneChat.emptyPaneChatState,
  ...overrides
})

const reply = (text: string): StoredEvent =>
  AgentEvents.MessageUpdated.make({
    itemId: `reply-${text}`,
    message: { role: 'assistant', content: text },
    streaming: false
  })

const attention = (runId: string, state: Attention.AttentionState): StoredEvent =>
  PaneEvents.PaneAttentionChanged.make({ paneId: runId, attention: state })

const completed = (runId: string) => attention(runId, Attention.Completed.make({}))

const userMessagesSent = (runId: string, text: string): StoredEvent =>
  PaneEvents.PaneUserMessagesSent.make({ paneId: runId, messages: [{ id: `sent-${text}`, text }] })

const queueChanged = (runId: string, texts: ReadonlyArray<string>, held = false): StoredEvent =>
  PaneEvents.PaneMessageQueueChanged.make({
    paneId: runId,
    queued: texts.map((text) => ({ id: `queued-${text}`, text })),
    held
  })

const makeWorld = (runList: ReadonlyArray<RunInfo>) =>
  Effect.gen(function* () {
    const committed = yield* PubSub.unbounded<CommittedEvent>()
    const sequence = yield* Ref.make(100)
    const snapshots = yield* Ref.make<ReadonlyMap<string, PaneChat.PaneChatSnapshot>>(new Map())
    const snapshotReads = yield* Queue.unbounded<string>()
    const seeded: Array<string> = []
    const sent: Array<Sent> = []
    const started: Array<StartRunOptions> = []
    const onSend = yield* Ref.make<(message: Sent) => Effect.Effect<void>>(() => Effect.void)
    const nothing = () => Effect.void

    const publish = (runId: string, events: ReadonlyArray<StoredEvent>) =>
      Effect.forEach(
        events,
        (event) =>
          Ref.updateAndGet(sequence, (current) => current + 1).pipe(
            Effect.flatMap((next) => PubSub.publish(committed, { runId, sequence: next, event }))
          ),
        { discard: true }
      )

    const runs: Runs = {
      open: () => Effect.die('not used'),
      start: (options) =>
        Effect.sync(() => {
          started.push(options)
          return RUN_B
        }),
      send: (runId, text, mode) =>
        Effect.flatMap(Ref.get(onSend), (hook) => {
          const message = { runId, text, mode }
          sent.push(message)
          return hook(message)
        }),
      editQueued: nothing,
      removeQueued: nothing,
      sendQueuedNow: nothing,
      answer: nothing,
      requests: Stream.make([]),
      busy: Stream.make([]),
      interrupt: nothing,
      resumeParked: nothing,
      rewind: nothing,
      setThinkingLevel: nothing,
      setPermissionMode: nothing,
      setModel: nothing,
      awaitIdle: nothing,
      isLive: (runId) => Effect.succeed(runList.find((run) => run.runId === runId)?.live ?? false),
      close: nothing,
      retire: nothing,
      list: Effect.succeed(runList),
      openInTab: nothing,
      changes: Stream.empty,
      discoverSessions: () => Effect.succeed([])
    }

    const runEvents: RunEvents = {
      append: () => Effect.die('not used'),
      committed: Stream.fromPubSub(committed),
      subscribe: Effect.map(PubSub.subscribe(committed), Stream.fromSubscription),
      readAfter: () => Effect.die('not used'),
      highestSequence: Effect.succeed(0),
      startSequence: 0,
      record: () => Effect.die('not used'),
      snapshot: (runId) =>
        Effect.gen(function* () {
          yield* Queue.offer(snapshotReads, runId)
          const stored = (yield* Ref.get(snapshots)).get(runId)
          return stored ?? { state: PaneChat.emptyPaneChatState, seq: 0 }
        }),
      seed: (runId) => Effect.sync(() => void seeded.push(runId)),
      release: nothing
    }

    const tools = yield* makeMessagingTools(runs, runEvents)
    const call = (name: string, input: unknown, scope: ToolScope = scopeOf(RUN_A)) => {
      const tool = tools.find((candidate) => candidate.name === name) as DiaTool
      return tool.run(input, scope) as Effect.Effect<DiaToolResult>
    }
    const setSnapshot = (runId: string, state: PaneChat.PaneChatState) =>
      Ref.update(snapshots, (current) => new Map(current).set(runId, { state, seq: 100 }))
    const snapshotRead = (runId: string) =>
      Queue.take(snapshotReads).pipe(Effect.repeat({ until: (read) => read === runId }))
    return {
      call,
      publish,
      setSnapshot,
      snapshotRead,
      sent,
      started,
      seeded,
      onSend: (hook: (message: Sent) => Effect.Effect<void>) => Ref.set(onSend, hook)
    }
  })

const A_AND_B = [info(RUN_A), info(RUN_B)]

describe('run_delegate', () => {
  it.effect("starts a run with the caller's settings and sends its reply to the caller once", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld([info(RUN_A)])
      const task = 'Count the files'
      const call = yield* Effect.forkChild(world.call('run_delegate', { task }))
      yield* world.snapshotRead(RUN_B)

      yield* world.publish(RUN_B, [userMessagesSent(RUN_B, task)])
      const result = yield* Fiber.join(call)
      yield* world.publish(RUN_B, [reply('There are 3 files.'), completed(RUN_B)])
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))

      const caller = info(RUN_A)
      assert.deepStrictEqual(
        {
          started: world.started,
          isError: result.isError,
          sent: world.sent
        },
        {
          started: [
            {
              cwd: caller.cwd,
              model: caller.model,
              thinkingLevel: caller.thinkingLevel,
              permissionMode: caller.permissionMode,
              text: task
            }
          ],
          isError: false,
          sent: [
            {
              runId: RUN_A,
              text: `Run ${RUN_B} completed the task you delegated. Its reply:\n\nThere are 3 files.`,
              mode: 'queue'
            }
          ]
        }
      )
    }).pipe(Effect.scoped)
  )

  it.effect('delivers the reply of a run that finished before its chat state was read', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld([info(RUN_A)])
      const task = 'Say done'
      yield* world.setSnapshot(
        RUN_B,
        stateWith({
          messages: [userMessage(task), assistantMessage('done')],
          attention: Attention.Completed.make({})
        })
      )

      yield* world.call('run_delegate', { task })
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))

      assert.deepStrictEqual(
        world.sent.map((message) => message.text),
        [`Run ${RUN_B} completed the task you delegated. Its reply:\n\ndone`]
      )
    }).pipe(Effect.scoped)
  )
})

describe('run_wait', () => {
  it.effect("returns a working run's reply once its turn completes", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld(A_AND_B)
      yield* world.setSnapshot(RUN_B, stateWith({ isLoading: true }))
      const call = yield* Effect.forkChild(world.call('run_wait', { runId: RUN_B }))
      yield* world.snapshotRead(RUN_B)

      yield* world.publish(RUN_B, [reply('All green.'), completed(RUN_B)])

      assert.deepStrictEqual(yield* Fiber.join(call), {
        text: `Run ${RUN_B} completed. Its last reply:\n\nAll green.`,
        isError: false
      })
    }).pipe(Effect.scoped)
  )

  it.effect('returns a settled live run’s reply at once', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld(A_AND_B)
      yield* world.setSnapshot(RUN_B, stateWith({ messages: [assistantMessage('Earlier answer')] }))

      const result = yield* world.call('run_wait', { runId: RUN_B })

      assert.deepStrictEqual(result, {
        text: `Run ${RUN_B} is idle. Its last reply:\n\nEarlier answer`,
        isError: false
      })
    }).pipe(Effect.scoped)
  )

  it.effect('seeds a run that is not live and returns its stored reply at once', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld([info(RUN_A), info(STOPPED, { live: false })])
      yield* world.setSnapshot(
        STOPPED,
        stateWith({ isLoading: true, messages: [assistantMessage('Stored answer')] })
      )

      const result = yield* world.call('run_wait', { runId: STOPPED })

      assert.deepStrictEqual(
        { result, seeded: world.seeded },
        {
          result: {
            text: `Run ${STOPPED} is not running. Its last reply:\n\nStored answer`,
            isError: false
          },
          seeded: [STOPPED]
        }
      )
    }).pipe(Effect.scoped)
  )

  it.effect('keeps waiting through a turn end while a message is queued to run next', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld(A_AND_B)
      yield* world.setSnapshot(
        RUN_B,
        stateWith({ isLoading: true, queued: [{ id: 'queued-next', text: 'next' }] })
      )
      const call = yield* Effect.forkChild(world.call('run_wait', { runId: RUN_B }))
      yield* world.snapshotRead(RUN_B)

      yield* world.publish(RUN_B, [
        reply('first'),
        completed(RUN_B),
        queueChanged(RUN_B, []),
        userMessagesSent(RUN_B, 'next'),
        reply('second'),
        completed(RUN_B)
      ])

      assert.strictEqual(
        (yield* Fiber.join(call)).text,
        `Run ${RUN_B} completed. Its last reply:\n\nsecond`
      )
    }).pipe(Effect.scoped)
  )

  it.effect('returns errored for a turn that errors while its queue is held', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld(A_AND_B)
      yield* world.setSnapshot(
        RUN_B,
        stateWith({ isLoading: true, queued: [{ id: 'queued-later', text: 'later' }] })
      )
      const call = yield* Effect.forkChild(world.call('run_wait', { runId: RUN_B }))
      yield* world.snapshotRead(RUN_B)

      yield* world.publish(RUN_B, [
        attention(RUN_B, Attention.Errored.make({ error: { message: 'boom' } })),
        queueChanged(RUN_B, ['later'], true)
      ])

      assert.isTrue((yield* Fiber.join(call)).text.startsWith(`Run ${RUN_B} errored.`))
    }).pipe(Effect.scoped)
  )

  it.effect('says the run is still working when the timeout passes', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld(A_AND_B)
      yield* world.setSnapshot(RUN_B, stateWith({ isLoading: true }))
      const call = yield* Effect.forkChild(
        world.call('run_wait', { runId: RUN_B, timeoutSeconds: 10 })
      )
      yield* world.snapshotRead(RUN_B)

      yield* TestClock.adjust(Duration.seconds(10))

      assert.deepStrictEqual(yield* Fiber.join(call), {
        text: `Run ${RUN_B} is still working; call run_wait again.`,
        isError: false
      })
    }).pipe(Effect.scoped)
  )

  it.effect('says the run waits for the user when it times out on an open request', () =>
    Effect.gen(function* () {
      const world = yield* makeWorld(A_AND_B)
      const awaiting = Attention.AwaitingPermission.make({
        request: Attention.PermissionRequest.make({
          requestId: 'r1',
          toolName: 'Bash',
          input: { command: 'ls' }
        })
      })
      yield* world.setSnapshot(RUN_B, stateWith({ isLoading: true, attention: awaiting }))
      const call = yield* Effect.forkChild(
        world.call('run_wait', { runId: RUN_B, timeoutSeconds: 10 })
      )
      yield* world.snapshotRead(RUN_B)

      yield* TestClock.adjust(Duration.seconds(10))

      assert.strictEqual(
        (yield* Fiber.join(call)).text,
        `Run ${RUN_B} waits for the user to answer a request.`
      )
    }).pipe(Effect.scoped)
  )
})

describe('run_send', () => {
  it.effect("queues the caller's message and returns once the run's log shows it", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld(A_AND_B)
      yield* world.onSend((message) =>
        world
          .snapshotRead(message.runId)
          .pipe(
            Effect.andThen(
              world.publish(message.runId, [queueChanged(message.runId, [message.text])])
            ),
            Effect.forkDetach,
            Effect.asVoid
          )
      )

      const result = yield* world.call('run_send', { runId: RUN_B, text: 'Rebase onto main' })

      assert.deepStrictEqual(
        { result, sent: world.sent },
        {
          result: { text: `Sent to run ${RUN_B}.`, isError: false },
          sent: [
            {
              runId: RUN_B,
              text: `Message from run ${RUN_A}:\n\nRebase onto main`,
              mode: 'queue'
            }
          ]
        }
      )
    }).pipe(Effect.scoped)
  )
})

describe('refused calls', () => {
  const refusals: ReadonlyArray<readonly [string, string, unknown, ToolScope]> = [
    ['run_send to an unknown run', 'run_send', { runId: STOPPED, text: 'hi' }, scopeOf(RUN_A)],
    ['run_send to an archived run', 'run_send', { runId: ARCHIVED, text: 'hi' }, scopeOf(RUN_A)],
    ['run_send to the caller', 'run_send', { runId: RUN_A, text: 'hi' }, scopeOf(RUN_A)],
    ['run_wait for an unknown run', 'run_wait', { runId: STOPPED }, scopeOf(RUN_A)],
    ['run_wait for the caller', 'run_wait', { runId: RUN_A }, scopeOf(RUN_A)],
    [
      'run_delegate outside a run',
      'run_delegate',
      { task: 'x' },
      { labels: [], context: undefined }
    ]
  ]

  for (const [name, tool, input, scope] of refusals) {
    it.effect(`refuses ${name} and sends nothing`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld([...A_AND_B, info(ARCHIVED, { status: 'archived' })])

        const result = yield* world.call(tool, input, scope)

        assert.deepStrictEqual(
          { isError: result.isError, sent: world.sent, started: world.started },
          { isError: true, sent: [], started: [] }
        )
      }).pipe(Effect.scoped)
    )
  }
})

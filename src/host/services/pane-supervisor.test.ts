import { assert, describe, it } from '@effect/vitest'
import { EMPTY_MESSAGE_QUEUE } from '@shared/domain/message-queue'
import {
  type PaneConfig,
  type PermissionMode,
  SessionId,
  type WorktreeInfo
} from '@shared/domain/pane'
import type { IpcEvent } from '@shared/ipc/contract'
import { WORKTREES_KEY } from '@shared/plugin/api'
import { Deferred, Effect, Layer, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { HostPlugins } from '../plugins/host-plugins'
import { PluginSources } from '../plugins/plugin-sources'
import type { AgentSession } from '../session/agent-backend'
import {
  MessageQueueChanged,
  type OutboundMessage,
  SessionStarted,
  UserMessagesSent
} from '../session/protocol'
import {
  type PaneCreationRequest,
  PaneSupervisor,
  PaneSupervisorLive,
  SessionFactory,
  SessionFactoryLive
} from './pane-supervisor'
import { type GitOps, WorktreeReattachError } from './worktrees-seam'

interface FakeSession {
  readonly config: PaneConfig
  readonly resume: Option.Option<SessionId>
  readonly calls: Array<string>
  readonly emit: (message: OutboundMessage) => Effect.Effect<void>
  readonly end: (reason: string) => Effect.Effect<void>
  closed: boolean
}

const requestA: PaneCreationRequest = {
  paneId: 'aaaaaaaa-0000-4000-8000-000000000001',
  sourceCwd: '/a',
  model: 'm',
  thinkingLevel: 'adaptive',
  permissionMode: 'default',
  worktree: undefined
}
const requestB: PaneCreationRequest = {
  paneId: 'bbbbbbbb-0000-4000-8000-000000000002',
  sourceCwd: '/b',
  model: 'm',
  thinkingLevel: 'adaptive',
  permissionMode: 'auto',
  worktree: undefined
}

const flush = Effect.repeat(Effect.yieldNow, { times: 50 })

const ignoreSessionId = (_sessionId: SessionId): Effect.Effect<void> => Effect.void
const ignorePermissionMode = (_mode: PermissionMode): Effect.Effect<void> => Effect.void

const attentionTags = (events: ReadonlyArray<IpcEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === 'PaneAttentionChanged' ? [event.attention._tag] : []))

const pluginsWith = (inject: (key: string) => Option.Option<unknown>) =>
  Layer.succeed(HostPlugins)({
    list: () => Effect.succeed([]),
    start: () => Effect.void,
    load: () => Effect.die(new Error('load should not be called in these tests')),
    unload: () => Effect.die(new Error('unload should not be called in these tests')),
    inject: (key) => Effect.succeed(inject(key))
  })

const noPlugins = pluginsWith(() => Option.none())

const pluginsProviding = (gitOps: GitOps) =>
  pluginsWith((key) => (key === WORKTREES_KEY ? Option.some(gitOps) : Option.none()))

const unusedGitOps: GitOps = {
  createWorktree: () => Effect.die(new Error('createWorktree should not be called in these tests')),
  removeWorktree: () => Effect.die(new Error('removeWorktree should not be called in these tests')),
  reattachWorktree: () =>
    Effect.die(new Error('reattachWorktree should not be called in these tests'))
}

function makeTestSetup(
  gitOps: GitOps = unusedGitOps,
  lifecycleLog: Array<string> = [],
  plugins: Layer.Layer<HostPlugins> = pluginsProviding(gitOps)
) {
  const sessions: Array<FakeSession> = []

  const factoryLayer = Layer.succeed(SessionFactory)({
    start: ({ config, resume, emit }) =>
      Effect.gen(function* () {
        const ended = yield* Deferred.make<string>()
        const calls: Array<string> = []
        const fake: FakeSession = {
          config,
          resume,
          calls,
          emit,
          end: (reason) => Deferred.succeed(ended, reason).pipe(Effect.asVoid),
          closed: false
        }
        sessions.push(fake)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            fake.closed = true
            lifecycleLog.push('session closed')
          })
        )
        const record =
          (name: string) =>
          (...args: ReadonlyArray<unknown>) =>
            Effect.sync(() => void calls.push([name, ...args.map(String)].join(':')))
        const session: AgentSession = {
          sendText: record('sendText'),
          editQueuedText: record('editQueuedText'),
          removeQueuedText: record('removeQueuedText'),
          messageQueue: Effect.succeed(EMPTY_MESSAGE_QUEUE),
          setThinkingLevel: record('setThinkingLevel'),
          setPermissionMode: record('setPermissionMode'),
          resolvePermission: record('resolvePermission'),
          resolveQuestion: record('resolveQuestion'),
          resolvePlanReview: record('resolvePlanReview'),
          interrupt: () => record('interrupt')(),
          rewindToCheckpoint: record('rewindToCheckpoint'),
          ended: Deferred.await(ended)
        }
        return session
      })
  })

  const testLayer = Layer.provide(PaneSupervisorLive, Layer.merge(factoryLayer, plugins))
  return { sessions, testLayer }
}

const unusedPluginSources = Layer.succeed(PluginSources)({
  names: () => Effect.succeed([]),
  resolve: () => Effect.succeed(Option.none()),
  setOverride: () => Effect.die(new Error('setOverride should not be called in these tests')),
  clearOverride: () => Effect.die(new Error('clearOverride should not be called in these tests'))
})

describe('SessionFactoryLive without the claude-code adapter', () => {
  it.effect('marks the pane Crashed once and removes it', () =>
    Effect.gen(function* () {
      const factory = Layer.provide(SessionFactoryLive, Layer.merge(noPlugins, unusedPluginSources))
      const testLayer = Layer.provide(PaneSupervisorLive, Layer.merge(factory, noPlugins))
      const events: Array<IpcEvent> = []

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => void events.push(event)),
          ignoreSessionId,
          ignorePermissionMode
        )
        yield* flush

        assert.isTrue(Option.isNone(yield* supervisor.getHandle(requestA.paneId)))
        assert.deepStrictEqual(attentionTags(events), ['Crashed'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )
})

describe('PaneSupervisor', () => {
  it.effect('removes a pane whose session ends on its own, leaving its sibling alive', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const eventsA: Array<IpcEvent> = []
        const eventsB: Array<IpcEvent> = []

        yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => void eventsA.push(event)),
          ignoreSessionId,
          ignorePermissionMode
        )
        const openedB = yield* supervisor.openPane(
          requestB,
          (event) => Effect.sync(() => void eventsB.push(event)),
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* sessions[0].emit({
          _tag: 'AssistantMessageReceived',
          message: { role: 'assistant', content: 'before the failure' }
        })
        yield* sessions[0].end('stream failed')
        yield* flush

        assert.isTrue(Option.isNone(yield* supervisor.getHandle(requestA.paneId)))
        assert.isTrue(Option.isSome(yield* supervisor.getHandle(requestB.paneId)))
        assert.isTrue(sessions[0].closed)
        assert.isFalse(sessions[1].closed)

        yield* openedB.handle.sendMessage('ping', 'queue')
        assert.deepStrictEqual(sessions[1].calls, ['sendText:ping:queue'])

        assert.deepStrictEqual(
          eventsA.map((event) => event._tag),
          ['PaneMessageAppended', 'PaneAttentionChanged']
        )
        assert.deepStrictEqual(attentionTags(eventsA), ['Crashed'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect(
    'delivers every event produced before a failure, in order, before closing the pane',
    () =>
      Effect.gen(function* () {
        const { sessions, testLayer } = makeTestSetup()

        yield* Effect.gen(function* () {
          const supervisor = yield* PaneSupervisor
          const delivered: Array<string> = []

          yield* supervisor.openPane(
            requestA,
            (event) =>
              Effect.sync(() => void delivered.push(event._tag)).pipe(
                Effect.andThen(Effect.yieldNow),
                Effect.andThen(Effect.yieldNow)
              ),
            ignoreSessionId,
            ignorePermissionMode
          )

          yield* sessions[0].emit({ _tag: 'AssistantTextDelta', text: 'one' })
          yield* sessions[0].emit({ _tag: 'AssistantTextDelta', text: 'two' })
          yield* sessions[0].end('boom')
          yield* flush

          assert.deepStrictEqual(delivered, [
            'PaneAssistantTextDelta',
            'PaneAssistantTextDelta',
            'PaneAttentionChanged'
          ])
          assert.isTrue(sessions[0].closed)
        }).pipe(Effect.scoped, Effect.provide(testLayer))
      })
  )

  it.effect('closing a pane ends its session without marking it crashed', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const eventsA: Array<IpcEvent> = []

        yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => void eventsA.push(event)),
          ignoreSessionId,
          ignorePermissionMode
        )
        yield* supervisor.openPane(
          requestB,
          () => Effect.void,
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* supervisor.closePane(requestA.paneId)
        yield* flush

        assert.isTrue(Option.isNone(yield* supervisor.getHandle(requestA.paneId)))
        assert.isTrue(Option.isSome(yield* supervisor.getHandle(requestB.paneId)))
        assert.isTrue(sessions[0].closed)
        assert.deepStrictEqual(attentionTags(eventsA), [])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('closeAll ends every pane’s session', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        yield* supervisor.openPane(
          requestA,
          () => Effect.void,
          ignoreSessionId,
          ignorePermissionMode
        )
        yield* supervisor.openPane(
          requestB,
          () => Effect.void,
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* supervisor.closeAll()

        assert.deepStrictEqual(
          sessions.map((session) => session.closed),
          [true, true]
        )
        assert.isTrue(Option.isNone(yield* supervisor.getHandle(requestA.paneId)))
        assert.isTrue(Option.isNone(yield* supervisor.getHandle(requestB.paneId)))
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('routes a SessionStarted event from the session to the onSessionId callback', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const sessionIds: Array<string> = []

        yield* supervisor.openPane(
          requestA,
          () => Effect.void,
          (sessionId) => Effect.sync(() => void sessionIds.push(sessionId)),
          ignorePermissionMode
        )

        yield* sessions[0].emit(SessionStarted.make({ sessionId: SessionId.make('session-xyz') }))

        assert.deepStrictEqual(sessionIds, ['session-xyz'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect(
    'resuming a worktree pane reattaches its branch and starts the session with resume',
    () =>
      Effect.gen(function* () {
        const reattachCalls: Array<{ info: WorktreeInfo; paneId: string }> = []
        const gitOps: GitOps = {
          createWorktree: () =>
            Effect.die(new Error('createWorktree must not be called when resuming')),
          removeWorktree: () => Effect.void,
          reattachWorktree: (info, paneId) =>
            Effect.sync(() => {
              reattachCalls.push({ info, paneId })
              return info
            })
        }
        const { sessions, testLayer } = makeTestSetup(gitOps)

        const expectedInfo: WorktreeInfo = {
          path: '/wt/c',
          branch: 'dia/brave-otter',
          sourceRepo: '/repo'
        }
        const resumeRequest: PaneCreationRequest = {
          paneId: 'cccccccc-0000-4000-8000-000000000003',
          sourceCwd: '/repo',
          model: 'm',
          thinkingLevel: 'adaptive',
          permissionMode: 'default',
          worktree: { _tag: 'Reattach', info: expectedInfo },
          resume: SessionId.make('session-resume-1')
        }

        yield* Effect.gen(function* () {
          const supervisor = yield* PaneSupervisor
          const opened = yield* supervisor.openPane(
            resumeRequest,
            () => Effect.void,
            ignoreSessionId,
            ignorePermissionMode
          )

          assert.deepStrictEqual(reattachCalls, [
            { info: expectedInfo, paneId: resumeRequest.paneId }
          ])
          assert.strictEqual(opened.config.cwd, '/wt/c')
          assert.deepStrictEqual(sessions[0].config, {
            paneId: resumeRequest.paneId,
            cwd: '/wt/c',
            model: 'm',
            thinkingLevel: 'adaptive',
            permissionMode: 'default',
            worktree: expectedInfo
          })
          assert.deepStrictEqual(
            sessions[0].resume,
            Option.some(SessionId.make('session-resume-1'))
          )
        }).pipe(Effect.scoped, Effect.provide(testLayer))
      })
  )

  it.effect('removes a worktree pane’s worktree only after its session has closed', () =>
    Effect.gen(function* () {
      const lifecycleLog: Array<string> = []
      const info: WorktreeInfo = { path: '/wt/d', branch: 'dia/calm-fox', sourceRepo: '/repo' }
      const gitOps: GitOps = {
        createWorktree: () => Effect.succeed(info),
        removeWorktree: () => Effect.sync(() => void lifecycleLog.push('worktree removed')),
        reattachWorktree: () => Effect.die(new Error('reattachWorktree should not be called'))
      }
      const { testLayer } = makeTestSetup(gitOps, lifecycleLog)

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        yield* supervisor.openPane(
          { ...requestA, worktree: { _tag: 'Create', worktreesRoot: '/wt' } },
          () => Effect.void,
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* supervisor.closePane(requestA.paneId)

        assert.deepStrictEqual(lifecycleLog, ['session closed', 'worktree removed'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('opens a new worktree pane in the project directory when worktrees is not loaded', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup(unusedGitOps, [], noPlugins)

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        yield* supervisor.openPane(
          { ...requestA, worktree: { _tag: 'Create', worktreesRoot: '/wt' } },
          () => Effect.void,
          ignoreSessionId,
          ignorePermissionMode
        )

        assert.strictEqual(sessions.length, 1)
        assert.strictEqual(sessions[0].config.cwd, requestA.sourceCwd)
        assert.isUndefined(sessions[0].config.worktree)
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect(
    'refuses to resume a worktree pane without starting a session when worktrees is not loaded',
    () =>
      Effect.gen(function* () {
        const { sessions, testLayer } = makeTestSetup(unusedGitOps, [], noPlugins)
        const info: WorktreeInfo = {
          path: '/wt/dia-calm-fox',
          branch: 'dia/calm-fox',
          sourceRepo: requestA.sourceCwd
        }

        yield* Effect.gen(function* () {
          const supervisor = yield* PaneSupervisor
          const result = yield* supervisor
            .openPane(
              { ...requestA, worktree: { _tag: 'Reattach', info } },
              () => Effect.void,
              ignoreSessionId,
              ignorePermissionMode
            )
            .pipe(Effect.result)

          assert.isTrue(Result.isFailure(result))
          if (Result.isFailure(result)) {
            assert.instanceOf(result.failure, WorktreeReattachError)
            assert.strictEqual(result.failure.path, info.path)
            assert.strictEqual(
              result.failure.cause,
              'Load the worktrees plugin to resume this pane'
            )
          }
          assert.strictEqual(sessions.length, 0)
        }).pipe(Effect.scoped, Effect.provide(testLayer))
      })
  )

  it.effect('auto-settles Completed back to Idle after 3 seconds', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const events: Array<IpcEvent> = []

        yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => void events.push(event)),
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* sessions[0].emit({ _tag: 'TurnCompleted' })
        yield* flush
        assert.deepStrictEqual(attentionTags(events), ['Completed'])

        yield* TestClock.adjust('3 seconds')
        yield* flush
        assert.deepStrictEqual(attentionTags(events), ['Completed', 'Idle'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('sends a permission-mode change to the target pane’s session only', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor

        const openedA = yield* supervisor.openPane(
          requestA,
          () => Effect.void,
          ignoreSessionId,
          ignorePermissionMode
        )
        yield* supervisor.openPane(
          requestB,
          () => Effect.void,
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* openedA.handle.setPermissionMode('acceptEdits')

        assert.deepStrictEqual(sessions[0].calls, ['setPermissionMode:acceptEdits'])
        assert.deepStrictEqual(sessions[1].calls, [])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect(
    'steering while AwaitingPermission clears attention so a later TurnCompleted lands',
    () =>
      Effect.gen(function* () {
        const { sessions, testLayer } = makeTestSetup()

        yield* Effect.gen(function* () {
          const supervisor = yield* PaneSupervisor
          const events: Array<IpcEvent> = []

          const opened = yield* supervisor.openPane(
            requestA,
            (event) => Effect.sync(() => void events.push(event)),
            ignoreSessionId,
            ignorePermissionMode
          )

          yield* sessions[0].emit({
            _tag: 'PermissionRequested',
            requestId: 'req-1',
            toolName: 'Bash',
            input: {}
          })
          yield* opened.handle.sendMessage('take this instead', 'steer')
          yield* sessions[0].emit({ _tag: 'TurnCompleted' })
          yield* flush

          assert.deepStrictEqual(attentionTags(events), ['AwaitingPermission', 'Idle', 'Completed'])
          assert.deepStrictEqual(sessions[0].calls, ['sendText:take this instead:steer'])
        }).pipe(Effect.scoped, Effect.provide(testLayer))
      })
  )

  it.effect('interrupt reaches the session and clears a pending permission', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const events: Array<IpcEvent> = []

        const opened = yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => void events.push(event)),
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* sessions[0].emit({
          _tag: 'PermissionRequested',
          requestId: 'req-1',
          toolName: 'Bash',
          input: {}
        })
        yield* opened.handle.interrupt()
        yield* flush

        assert.deepStrictEqual(attentionTags(events), ['AwaitingPermission', 'Idle'])
        assert.deepStrictEqual(sessions[0].calls, ['interrupt'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('queueing while AwaitingPermission leaves the permission pending', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const events: Array<IpcEvent> = []

        const opened = yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => void events.push(event)),
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* sessions[0].emit({
          _tag: 'PermissionRequested',
          requestId: 'req-1',
          toolName: 'Bash',
          input: {}
        })
        yield* opened.handle.sendMessage('after you finish', 'queue')
        yield* flush

        assert.deepStrictEqual(attentionTags(events), ['AwaitingPermission'])
        assert.deepStrictEqual(sessions[0].calls, ['sendText:after you finish:queue'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('a batch of sent user messages moves a Completed pane back to Idle', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const events: Array<IpcEvent> = []

        yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => void events.push(event)),
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* sessions[0].emit({ _tag: 'TurnCompleted' })
        yield* sessions[0].emit(UserMessagesSent.make({ messages: [{ id: 'm-1', text: 'next' }] }))
        yield* flush

        assert.deepStrictEqual(attentionTags(events), ['Completed', 'Idle'])
        assert.deepStrictEqual(
          events.find((event) => event._tag === 'PaneUserMessagesSent'),
          {
            _tag: 'PaneUserMessagesSent',
            paneId: requestA.paneId,
            messages: [{ id: 'm-1', text: 'next' }]
          }
        )
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('publishes a session queue change as a pane event carrying the queue', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const events: Array<IpcEvent> = []

        yield* supervisor.openPane(
          requestA,
          (event) => Effect.sync(() => void events.push(event)),
          ignoreSessionId,
          ignorePermissionMode
        )

        yield* sessions[0].emit(
          MessageQueueChanged.make({ queued: [{ id: 'm-2', text: 'later' }], held: true })
        )
        yield* flush

        assert.deepStrictEqual(events, [
          {
            _tag: 'PaneMessageQueueChanged',
            paneId: requestA.paneId,
            queued: [{ id: 'm-2', text: 'later' }],
            held: true
          }
        ])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )
})

import { assert, describe, it } from '@effect/vitest'
import { EMPTY_MESSAGE_QUEUE } from '@shared/domain/message-queue'
import {
  type PaneConfig,
  type PermissionMode,
  SessionId,
  type WorktreeInfo
} from '@shared/domain/pane'
import { SignedOut, UsageLimit, type UsageLimitResume } from '@shared/domain/parking'
import { type IpcEvent, PaneRewindFailed } from '@shared/ipc/contract'
import { WORKTREES_KEY } from '@shared/plugin/api'
import { Deferred, Effect, Layer, Option, Result, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { HostPlugins } from '../plugins/host-plugins'
import { PluginSources } from '../plugins/plugin-sources'
import {
  type AgentSession,
  type SessionEnd,
  SessionFailed,
  SessionNotFound
} from '../session/agent-backend'
import {
  MessageQueueChanged,
  type OutboundMessage,
  RewindFailed,
  SessionStarted,
  TurnParked,
  UserMessagesSent
} from '../session/protocol'
import {
  type PaneCreationRequest,
  PaneSupervisor,
  PaneSupervisorLive,
  SessionFactory,
  SessionFactoryLive
} from './pane-supervisor'
import { SettingsStore } from './settings-store'
import { type GitOps, WorktreeReattachError } from './worktrees-seam'

interface FakeSession {
  readonly config: PaneConfig
  readonly resume: Option.Option<SessionId>
  readonly calls: Array<string>
  readonly emit: (message: OutboundMessage) => Effect.Effect<void>
  readonly end: (reason: string) => Effect.Effect<void>
  readonly endWith: (end: SessionEnd) => Effect.Effect<void>
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

const ignoreSessionId = (_sessionId: Option.Option<SessionId>): Effect.Effect<void> => Effect.void
const ignorePermissionMode = (_mode: PermissionMode): Effect.Effect<void> => Effect.void

const attentionTags = (events: ReadonlyArray<IpcEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === 'PaneAttentionChanged' ? [event.attention._tag] : []))

const pluginsWith = (inject: (key: string) => Option.Option<unknown>) =>
  Layer.succeed(HostPlugins)({
    list: () => Effect.succeed([]),
    start: () => Effect.void,
    changes: Stream.empty,
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

const unused = (name: string) => () => Effect.die(new Error(`${name} should not be called`))

const memorySettings = (initial?: UsageLimitResume) => {
  let stored = initial
  return Layer.succeed(SettingsStore)({
    getTheme: unused('getTheme'),
    setTheme: unused('setTheme'),
    getSendMode: unused('getSendMode'),
    setSendMode: unused('setSendMode'),
    getTranscriptWidth: unused('getTranscriptWidth'),
    setTranscriptWidth: unused('setTranscriptWidth'),
    getUsageLimitResume: () => Effect.sync(() => Option.fromUndefinedOr(stored)),
    setUsageLimitResume: (mode) =>
      Effect.sync(() => {
        stored = mode
      }),
    getPluginOverrides: unused('getPluginOverrides'),
    setPluginOverride: unused('setPluginOverride'),
    clearPluginOverride: unused('clearPluginOverride'),
    getAdapterPreferences: unused('getAdapterPreferences'),
    setAdapterPreferences: unused('setAdapterPreferences')
  })
}

function makeTestSetup(
  gitOps: GitOps = unusedGitOps,
  lifecycleLog: Array<string> = [],
  plugins: Layer.Layer<HostPlugins> = pluginsProviding(gitOps),
  usageLimitResume?: UsageLimitResume
) {
  const sessions: Array<FakeSession> = []

  const factoryLayer = Layer.succeed(SessionFactory)({
    start: ({ config, resume, emit }) =>
      Effect.gen(function* () {
        const ended = yield* Deferred.make<SessionEnd>()
        const endWith = (end: SessionEnd) => Deferred.succeed(ended, end).pipe(Effect.asVoid)
        const calls: Array<string> = []
        const fake: FakeSession = {
          config,
          resume,
          calls,
          emit,
          end: (reason) => endWith(SessionFailed.make({ reason })),
          endWith,
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
          setModel: record('setModel'),
          resolvePermission: record('resolvePermission'),
          resolveQuestion: record('resolveQuestion'),
          resolvePlanReview: record('resolvePlanReview'),
          interrupt: () => record('interrupt')(),
          rewindToCheckpoint: record('rewindToCheckpoint'),
          resume: record('resume')(),
          ended: Deferred.await(ended)
        }
        return session
      })
  })

  const testLayer = Layer.provide(
    PaneSupervisorLive,
    Layer.mergeAll(factoryLayer, plugins, memorySettings(usageLimitResume))
  )
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
      const testLayer = Layer.provide(
        PaneSupervisorLive,
        Layer.mergeAll(factory, noPlugins, memorySettings())
      )
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

  it.effect('routes a SessionStarted event from the session to the onSessionChanged callback', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const supervisor = yield* PaneSupervisor
        const sessionIds: Array<Option.Option<SessionId>> = []

        yield* supervisor.openPane(
          requestA,
          () => Effect.void,
          (sessionId) => Effect.sync(() => void sessionIds.push(sessionId)),
          ignorePermissionMode
        )

        yield* sessions[0].emit(SessionStarted.make({ sessionId: SessionId.make('session-xyz') }))

        assert.deepStrictEqual(sessionIds, [Option.some(SessionId.make('session-xyz'))])
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

  it.effect('publishes a failed rewind as a pane event carrying its cause and detail', () =>
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
          RewindFailed.make({
            messageUuid: 'turn-2',
            cause: 'FilesNotRewound',
            detail: 'No file checkpoint found for this message.'
          })
        )
        yield* sessions[0].emit(RewindFailed.make({ messageUuid: 'turn-3', cause: 'Interrupted' }))
        yield* flush

        assert.deepStrictEqual(events, [
          PaneRewindFailed.make({
            paneId: requestA.paneId,
            messageUuid: 'turn-2',
            cause: 'FilesNotRewound',
            detail: 'No file checkpoint found for this message.'
          }),
          PaneRewindFailed.make({
            paneId: requestA.paneId,
            messageUuid: 'turn-3',
            cause: 'Interrupted'
          })
        ])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )
})

const HOUR_MS = 60 * 60 * 1000
const GRACE_MS = 5000

const parkedEvents = (events: ReadonlyArray<IpcEvent>) =>
  events.flatMap((event) =>
    event._tag === 'PaneAttentionChanged' &&
    (event.attention._tag === 'ParkedToResume' ||
      event.attention._tag === 'ParkedUntilReset' ||
      event.attention._tag === 'ParkedForUser')
      ? [event.attention]
      : []
  )

const openPaneA = (events: Array<IpcEvent>) =>
  Effect.gen(function* () {
    const supervisor = yield* PaneSupervisor
    const opened = yield* supervisor.openPane(
      requestA,
      (event) => Effect.sync(() => void events.push(event)),
      ignoreSessionId,
      ignorePermissionMode
    )
    return { supervisor, handle: opened.handle }
  })

const limitResetAt = (resetsAt: number) => TurnParked.make({ cause: UsageLimit.make({ resetsAt }) })

describe('PaneSupervisor parking', () => {
  it.effect('waits for a usage limit to reset and sends continue five seconds after it', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const events: Array<IpcEvent> = []
        yield* openPaneA(events)

        yield* sessions[0].emit(limitResetAt(HOUR_MS))
        yield* flush
        assert.deepStrictEqual(parkedEvents(events), [
          {
            _tag: 'ParkedToResume',
            cause: { _tag: 'UsageLimit', resetsAt: HOUR_MS },
            resumesAt: HOUR_MS + GRACE_MS
          }
        ])

        yield* TestClock.adjust(HOUR_MS + GRACE_MS - 1)
        yield* flush
        assert.deepStrictEqual(sessions[0].calls, [])

        yield* TestClock.adjust(1)
        yield* flush
        assert.deepStrictEqual(sessions[0].calls, ['resume'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('under manual, waits for the reset and then for the user, without resuming', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup(undefined, undefined, undefined, 'manual')

      yield* Effect.gen(function* () {
        const events: Array<IpcEvent> = []
        yield* openPaneA(events)
        const cause = { _tag: 'UsageLimit', resetsAt: HOUR_MS } as const

        yield* sessions[0].emit(limitResetAt(HOUR_MS))
        yield* flush
        yield* TestClock.adjust(HOUR_MS - 1)
        yield* flush
        assert.deepStrictEqual(parkedEvents(events), [
          { _tag: 'ParkedUntilReset', cause, resetsAt: HOUR_MS }
        ])

        yield* TestClock.adjust(1)
        yield* flush
        assert.deepStrictEqual(parkedEvents(events), [
          { _tag: 'ParkedUntilReset', cause, resetsAt: HOUR_MS },
          { _tag: 'ParkedForUser', cause }
        ])
        assert.deepStrictEqual(sessions[0].calls, [])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('waits for the user at once when the reset time has already passed', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup(undefined, undefined, undefined, 'manual')

      yield* Effect.gen(function* () {
        const events: Array<IpcEvent> = []
        yield* openPaneA(events)

        yield* TestClock.adjust(HOUR_MS)
        yield* sessions[0].emit(limitResetAt(HOUR_MS))
        yield* flush

        assert.deepStrictEqual(
          parkedEvents(events).map((attention) => attention._tag),
          ['ParkedForUser']
        )
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('waits for the user when signed out', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const events: Array<IpcEvent> = []
        yield* openPaneA(events)

        yield* sessions[0].emit(TurnParked.make({ cause: SignedOut.make({}) }))
        yield* flush

        assert.deepStrictEqual(parkedEvents(events), [
          { _tag: 'ParkedForUser', cause: { _tag: 'SignedOut' } }
        ])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect(
    'waits for the reset, then the user, when the reset is more than seven days ahead',
    () =>
      Effect.gen(function* () {
        const { sessions, testLayer } = makeTestSetup()

        yield* Effect.gen(function* () {
          const events: Array<IpcEvent> = []
          yield* openPaneA(events)

          yield* sessions[0].emit(limitResetAt(7 * 24 * HOUR_MS))
          yield* flush

          assert.deepStrictEqual(
            parkedEvents(events).map((attention) => attention._tag),
            ['ParkedUntilReset']
          )
        }).pipe(Effect.scoped, Effect.provide(testLayer))
      })
  )

  it.effect('re-parks a pane dia would resume for the user when the mode changes to manual', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const events: Array<IpcEvent> = []
        const { supervisor } = yield* openPaneA(events)

        yield* sessions[0].emit(limitResetAt(HOUR_MS))
        yield* flush
        yield* supervisor.setUsageLimitResume('manual')
        yield* TestClock.adjust(2 * HOUR_MS)
        yield* flush

        assert.deepStrictEqual(
          parkedEvents(events).map((attention) => attention._tag),
          ['ParkedToResume', 'ParkedUntilReset', 'ParkedForUser']
        )
        assert.deepStrictEqual(sessions[0].calls, [])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('parks the next refusal under the mode the user stored', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const events: Array<IpcEvent> = []
        const { supervisor } = yield* openPaneA(events)

        yield* supervisor.setUsageLimitResume('manual')
        yield* sessions[0].emit(limitResetAt(HOUR_MS))
        yield* flush

        assert.deepStrictEqual(
          parkedEvents(events).map((attention) => attention._tag),
          ['ParkedUntilReset']
        )
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('a user resume of a parked pane reaches the session', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const { handle } = yield* openPaneA([])

        yield* sessions[0].emit(TurnParked.make({ cause: SignedOut.make({}) }))
        yield* handle.resume

        assert.deepStrictEqual(sessions[0].calls, ['resume'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('a user resume of a pane that is not parked does nothing', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const { handle } = yield* openPaneA([])

        yield* handle.resume

        assert.deepStrictEqual(sessions[0].calls, [])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('a message sent while waiting for the reset cancels the automatic resume', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const events: Array<IpcEvent> = []
        yield* openPaneA(events)

        yield* sessions[0].emit(limitResetAt(HOUR_MS))
        yield* sessions[0].emit(UserMessagesSent.make({ messages: [{ id: 'm-1', text: 'go' }] }))
        yield* TestClock.adjust(2 * HOUR_MS)
        yield* flush

        assert.deepStrictEqual(attentionTags(events), ['ParkedToResume', 'Idle'])
        assert.deepStrictEqual(sessions[0].calls, [])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('a rewind leaves the parked state', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const events: Array<IpcEvent> = []
        const { handle } = yield* openPaneA(events)

        yield* sessions[0].emit(TurnParked.make({ cause: SignedOut.make({}) }))
        yield* handle.rewindToCheckpoint('u-1', undefined)
        yield* flush

        assert.deepStrictEqual(attentionTags(events), ['ParkedForUser', 'Idle'])
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )
})

describe('PaneSupervisor when the resumed conversation is gone', () => {
  const missing = SessionId.make('9c376084-48c1-4e74-b886-7915ef2993db')
  const NOT_FOUND_NOTICE =
    "This tab's conversation could not be found. Send your message again to start a new conversation."

  const openRecording = Effect.fnUntraced(function* () {
    const supervisor = yield* PaneSupervisor
    const events: Array<IpcEvent> = []
    const sessionChanges: Array<Option.Option<SessionId>> = []
    yield* supervisor.openPane(
      { ...requestA, resume: missing },
      (event) => Effect.sync(() => void events.push(event)),
      (sessionId) => Effect.sync(() => void sessionChanges.push(sessionId)),
      ignorePermissionMode
    )
    return { supervisor, events, sessionChanges }
  })

  it.effect('clears the session, empties the queue, shows the notice and removes the pane', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const { supervisor, events, sessionChanges } = yield* openRecording()

        yield* sessions[0].endWith(SessionNotFound.make({ sessionId: missing }))
        yield* flush

        assert.deepStrictEqual(sessionChanges, [Option.none()])
        assert.deepStrictEqual(
          events.map((event) =>
            event._tag === 'PaneAttentionChanged'
              ? event.attention
              : event._tag === 'PaneMessageQueueChanged'
                ? { queued: event.queued, held: event.held }
                : event._tag
          ),
          [
            { queued: [], held: false },
            { _tag: 'Errored', error: { message: NOT_FOUND_NOTICE } }
          ]
        )
        assert.isTrue(Option.isNone(yield* supervisor.getHandle(requestA.paneId)))
        assert.isTrue(sessions[0].closed)
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('keeps the session and marks the pane Crashed for any other end', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const { supervisor, events, sessionChanges } = yield* openRecording()

        yield* sessions[0].end('stream failed')
        yield* flush

        assert.deepStrictEqual(sessionChanges, [])
        assert.deepStrictEqual(attentionTags(events), ['Crashed'])
        assert.isTrue(Option.isNone(yield* supervisor.getHandle(requestA.paneId)))
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )

  it.effect('clears the session and removes a parked pane without the notice', () =>
    Effect.gen(function* () {
      const { sessions, testLayer } = makeTestSetup()

      yield* Effect.gen(function* () {
        const { supervisor, events, sessionChanges } = yield* openRecording()
        yield* sessions[0].emit(TurnParked.make({ cause: SignedOut.make({}) }))
        yield* flush

        yield* sessions[0].endWith(SessionNotFound.make({ sessionId: missing }))
        yield* flush

        assert.deepStrictEqual(sessionChanges, [Option.none()])
        assert.deepStrictEqual(attentionTags(events), ['ParkedForUser'])
        assert.isTrue(Option.isNone(yield* supervisor.getHandle(requestA.paneId)))
      }).pipe(Effect.scoped, Effect.provide(testLayer))
    })
  )
})

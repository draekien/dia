import {
  Attention,
  BackgroundTasksChanged,
  NO_SESSION_ADDITIONS,
  type OutboundMessage,
  PermissionAnswer,
  PermissionRequested,
  type RunChange,
  type RunEvents,
  SessionId,
  SessionStarted,
  type ToolScope,
  UserMessagesSent
} from '@dia/plugin'
import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import type { IpcEvent } from '@shared/ipc/contract'
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Schedule,
  Scope,
  Stream
} from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { TurnCompleted } from '../../src/host/session/protocol'
import {
  type AgentBackend,
  type AgentSession,
  type SessionEnd,
  unavailableBackend
} from './backend'
import { runsMigrations } from './migrations'
import { makeRunRegistry } from './run-registry'
import { makeRunRows, type RunRows } from './run-rows'

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'
const STARTED = 'bbbbbbbb-0000-4000-8000-000000000002'
const SESSION = SessionId.make('session-1')

interface FakeSession {
  readonly resume: Option.Option<SessionId>
  readonly calls: Array<string>
  readonly emit: (message: OutboundMessage) => Effect.Effect<void>
}

const makeWorld = (rows: RunRows) => {
  const sessions: Array<FakeSession> = []
  const appended: Array<IpcEvent> = []
  const logOrder: Array<string> = []
  const toolScopes: Array<ToolScope> = []
  const backend: AgentBackend = {
    ...unavailableBackend,
    openSession: ({ resume, emit }) =>
      Effect.gen(function* () {
        const ended = yield* Deferred.make<SessionEnd>()
        const calls: Array<string> = []
        sessions.push({ resume, calls, emit })
        const record =
          (name: string) =>
          (...args: ReadonlyArray<unknown>) =>
            Effect.sync(() => void calls.push([name, ...args.map(String)].join(':')))
        const session: AgentSession = {
          sendText: (text, mode) => record('sendText')(text, mode),
          editQueuedText: record('editQueuedText'),
          removeQueuedText: record('removeQueuedText'),
          sendQueuedNow: record('sendQueuedNow'),
          messageQueue: Effect.succeed({ queued: [], held: false }),
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
  }
  const runEvents = {
    append: (_runId: string, entries: ReadonlyArray<{ readonly event: IpcEvent }>) =>
      Effect.sync(() => {
        appended.push(...entries.map((entry) => entry.event))
        logOrder.push(...entries.map((entry) => entry.event._tag))
        return entries.map(() => Option.some(1))
      }),
    seed: () => Effect.void,
    record: () =>
      Effect.succeed((message: OutboundMessage) =>
        Effect.sync(() => void logOrder.push(message._tag))
      )
  } as unknown as RunEvents
  const registry = makeRunRegistry({
    rows,
    backend: Effect.succeed(backend),
    runEvents: Effect.succeed(Option.some(runEvents)),
    gitOps: Effect.succeed(Option.none()),
    additions: Effect.succeed(NO_SESSION_ADDITIONS),
    sessionTools: (scope) =>
      Effect.sync(() => {
        toolScopes.push(scope)
        return Option.none()
      }),
    usageLimitResume: Effect.succeed('automatic'),
    newRunId: Effect.succeed(STARTED)
  })
  return { sessions, appended, logOrder, toolScopes, registry }
}

const eventually = <A>(read: Effect.Effect<A>, done: (value: A) => boolean) =>
  read.pipe(
    Effect.flatMap((value) => (done(value) ? Effect.succeed(value) : Effect.fail(value))),
    Effect.retry({ times: 200, schedule: Schedule.spaced(Duration.millis(5)) }),
    Effect.catch((value) => Effect.succeed(value))
  )

const withRows = <A, E>(body: (rows: RunRows) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-runs-' })
    const sql = yield* openDatabase(`${dir}/data.db`, runsMigrations)
    const rows = yield* makeRunRows.pipe(Effect.provideService(SqlClient.SqlClient, sql))
    return yield* body(rows)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const tabSpec = {
  runId: RUN,
  sourceCwd: '/repo',
  model: 'm',
  thinkingLevel: 'adaptive' as const,
  permissionMode: 'default' as const,
  worktree: undefined,
  resume: Option.none<SessionId>()
}

const startOptions = {
  cwd: '/repo',
  model: 'm',
  thinkingLevel: 'adaptive' as const,
  permissionMode: 'default' as const,
  text: 'tidy the README'
}

const statusOf = (rows: RunRows, runId: string) =>
  Effect.map(
    rows.get(runId),
    Option.map((row) => row.status)
  )

describe('run registry', () => {
  it.live('sends a message to a tab run and records the run as having a tab', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const world = makeWorld(rows)
        const { runs } = yield* world.registry

        yield* runs.open(tabSpec)
        yield* runs.send(RUN, 'hello', 'queue')

        assert.deepStrictEqual(world.sessions[0]?.calls, ['sendText:hello:queue'])
        assert.isTrue(Option.getOrThrow(yield* rows.get(RUN)).hasTab)
      })
    )
  )

  it.live('starts a run with no tab, sends it the text, and records it without a tab', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const world = makeWorld(rows)
        const { runs } = yield* world.registry

        const runId = yield* runs.start(startOptions)

        assert.strictEqual(runId, STARTED)
        assert.deepStrictEqual(world.sessions[0]?.calls, ['sendText:tidy the README:queue'])
        assert.isFalse(Option.getOrThrow(yield* rows.get(STARTED)).hasTab)
      })
    )
  )

  it.live("opens a started run's session with its labels and context after a restart", () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const before = makeWorld(rows)
        const firstStart = yield* Scope.make()
        const { runs } = yield* before.registry.pipe(Effect.provideService(Scope.Scope, firstStart))
        yield* runs.start({ ...startOptions, labels: ['issue'], context: { issueId: 'i-1' } })
        yield* Scope.close(firstStart, Exit.void)

        const after = makeWorld(rows)
        const reopened = yield* after.registry
        yield* reopened.runs.send(STARTED, 'continue', 'queue')

        const expected: ToolScope = {
          runId: STARTED,
          project: '/repo',
          labels: ['issue'],
          context: { issueId: 'i-1' }
        }
        assert.deepStrictEqual(after.toolScopes, [expected])
      })
    )
  )

  it.live('resumes the turn in progress of a run with no tab after a restart', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const before = makeWorld(rows)
        const firstStart = yield* Scope.make()
        const { runs } = yield* before.registry.pipe(Effect.provideService(Scope.Scope, firstStart))
        yield* runs.start(startOptions)
        const session = before.sessions[0]
        if (session === undefined) return assert.fail('no session opened')
        yield* session.emit(SessionStarted.make({ sessionId: SESSION }))
        yield* session.emit(UserMessagesSent.make({ messages: [] }))
        yield* eventually(statusOf(rows, STARTED), (status) => Option.contains(status, 'running'))
        yield* Scope.close(firstStart, Exit.void)

        const after = makeWorld(rows)
        const { recover } = yield* after.registry
        yield* recover

        assert.deepStrictEqual(
          after.sessions.map((resumed) => [resumed.resume, resumed.calls]),
          [[Option.some(SESSION), ['resume']]]
        )
      })
    )
  )

  it.live('does not open an idle run on recovery', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        yield* rows.upsert(
          RUN,
          {
            sourceCwd: '/repo',
            model: 'm',
            thinkingLevel: 'adaptive',
            permissionMode: 'default',
            worktree: null
          },
          Option.some(SESSION),
          true
        )
        const world = makeWorld(rows)
        const { recover } = yield* world.registry

        yield* recover

        assert.deepStrictEqual(world.sessions, [])
      })
    )
  )

  it.live(
    'sets a run that waited for an answer at shutdown idle on recovery, without opening it',
    () =>
      withRows((rows) =>
        Effect.gen(function* () {
          yield* rows.upsert(
            RUN,
            {
              sourceCwd: '/repo',
              model: 'm',
              thinkingLevel: 'adaptive',
              permissionMode: 'default',
              worktree: null
            },
            Option.some(SESSION),
            true
          )
          yield* rows.setStatus(RUN, 'waiting')
          const world = makeWorld(rows)
          const { recover } = yield* world.registry

          yield* recover

          assert.deepStrictEqual(
            [yield* statusOf(rows, RUN), world.sessions.length],
            [Option.some('idle'), 0]
          )
        })
      )
  )

  it.live('marks a run cut off before its session started idle and tells the user to resend', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        yield* rows.upsert(
          RUN,
          {
            sourceCwd: '/repo',
            model: 'm',
            thinkingLevel: 'adaptive',
            permissionMode: 'default',
            worktree: null
          },
          Option.none(),
          true
        )
        yield* rows.setStatus(RUN, 'running')
        const world = makeWorld(rows)
        const { recover } = yield* world.registry

        yield* recover

        assert.deepStrictEqual(yield* statusOf(rows, RUN), Option.some('idle'))
        assert.deepStrictEqual(world.sessions, [])
        assert.deepStrictEqual(
          world.appended.flatMap((event) =>
            event._tag === 'PaneAttentionChanged' && event.attention._tag === 'Errored'
              ? [event.attention.error.message]
              : []
          ),
          ['The turn was interrupted before it started. Send your message again.']
        )
      })
    )
  )

  it.live('asks for a tab for a run with no tab and records that it has one', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const world = makeWorld(rows)
        const { runs } = yield* world.registry
        yield* runs.start(startOptions)
        const requested = yield* runs.changes.pipe(
          Stream.filter((change: RunChange) => change._tag === 'RunTabRequested'),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true })
        )

        yield* runs.openInTab(STARTED)

        assert.deepStrictEqual(
          (yield* Fiber.join(requested)).map((change) => [change.runId, change._tag]),
          [[STARTED, 'RunTabRequested']]
        )
        assert.isTrue(Option.getOrThrow(yield* rows.get(STARTED)).hasTab)
      })
    )
  )

  it.live('lists the permission request of a run with no tab until it is answered', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const world = makeWorld(rows)
        const { runs } = yield* world.registry
        yield* runs.start(startOptions)
        const [session] = world.sessions
        if (session === undefined) return assert.fail('the run opened no session')
        yield* session.emit(SessionStarted.make({ sessionId: SESSION }))
        yield* session.emit(UserMessagesSent.make({ messages: [] }))

        yield* session.emit(
          PermissionRequested.make({ requestId: 'p1', toolName: 'Bash', input: {} })
        )
        const listed = yield* eventually(Stream.runHead(runs.requests), (current) =>
          Option.exists(current, (requests) => requests.length === 1)
        )

        assert.deepStrictEqual(
          Option.map(listed, (requests) =>
            requests.map(({ runId, request }) => [runId, request.requestId])
          ),
          Option.some([[STARTED, 'p1']])
        )
      })
    )
  )

  it.live('passes an answer to the session, resumes the run and drops the request', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const world = makeWorld(rows)
        const { runs } = yield* world.registry
        yield* runs.start(startOptions)
        const [session] = world.sessions
        if (session === undefined) return assert.fail('the run opened no session')
        yield* session.emit(SessionStarted.make({ sessionId: SESSION }))
        yield* session.emit(UserMessagesSent.make({ messages: [] }))
        yield* session.emit(
          PermissionRequested.make({ requestId: 'p1', toolName: 'Bash', input: {} })
        )
        yield* eventually(statusOf(rows, STARTED), (status) => Option.contains(status, 'waiting'))

        yield* runs.answer(
          STARTED,
          'p1',
          PermissionAnswer.make({ response: Attention.Allow.make({}) })
        )

        const remaining = yield* eventually(Stream.runHead(runs.requests), (current) =>
          Option.exists(current, (requests) => requests.length === 0)
        )
        assert.deepStrictEqual(
          [
            session.calls.filter((call) => call.startsWith('resolvePermission:p1:')).length,
            yield* statusOf(rows, STARTED),
            Option.map(remaining, (requests) => requests.length)
          ],
          [1, Option.some('running'), Option.some(0)]
        )
      })
    )
  )
})

const busyNow = (runs: { readonly busy: Stream.Stream<ReadonlyArray<string>> }) =>
  Effect.map(
    Stream.runHead(runs.busy),
    Option.getOrElse(() => [])
  )

describe('busy runs', () => {
  it.live('counts a started run as busy before its session reports the turn', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const { runs } = yield* makeWorld(rows).registry

        yield* runs.start(startOptions)

        assert.deepStrictEqual(yield* busyNow(runs), [STARTED])
      })
    )
  )

  it.live('does not count a run waiting for the user', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const world = makeWorld(rows)
        const { runs } = yield* world.registry
        yield* runs.start(startOptions)
        const [session] = world.sessions
        if (session === undefined) return assert.fail('the run opened no session')
        yield* session.emit(UserMessagesSent.make({ messages: [] }))

        yield* session.emit(
          PermissionRequested.make({ requestId: 'p1', toolName: 'Bash', input: {} })
        )

        assert.deepStrictEqual(yield* eventually(busyNow(runs), (busy) => busy.length === 0), [])
      })
    )
  )

  it.live('counts a run whose turn ended while a background task runs, until it ends', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const world = makeWorld(rows)
        const { runs } = yield* world.registry
        yield* runs.start(startOptions)
        const [session] = world.sessions
        if (session === undefined) return assert.fail('the run opened no session')
        yield* session.emit(UserMessagesSent.make({ messages: [] }))
        yield* session.emit(
          BackgroundTasksChanged.make({ tasks: [{ taskId: 't1', description: 'build' }] })
        )

        yield* session.emit(TurnCompleted.make({}))
        const whileTaskRuns = yield* busyNow(runs)
        yield* session.emit(BackgroundTasksChanged.make({ tasks: [] }))
        const afterTaskEnds = yield* eventually(busyNow(runs), (busy) => busy.length === 0)

        assert.deepStrictEqual([whileTaskRuns, afterTaskEnds], [[STARTED], []])
      })
    )
  )
})

describe('run event order', () => {
  it.live("records a turn's end before the attention signal that ends the turn", () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const world = makeWorld(rows)
        const { runs } = yield* world.registry
        yield* runs.start(startOptions)
        const [session] = world.sessions
        if (session === undefined) return assert.fail('the run opened no session')

        yield* session.emit(TurnCompleted.make({}))
        const order = yield* eventually(
          Effect.sync(() => [...world.logOrder]),
          (logged) => logged.includes('PaneAttentionChanged')
        )

        assert.deepStrictEqual(
          order.filter((tag) => tag === 'TurnCompleted' || tag === 'PaneAttentionChanged'),
          ['TurnCompleted', 'PaneAttentionChanged']
        )
      })
    )
  )
})

describe('run rows', () => {
  it.live('claims a call id once, so a resent call applies nothing', () =>
    withRows((rows) =>
      Effect.gen(function* () {
        const first = yield* rows.claim('call-1', RUN, 'SendMessage')
        const resent = yield* rows.claim('call-1', RUN, 'SendMessage')

        assert.deepStrictEqual([first, resent], [true, false])
      })
    )
  )
})

import {
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  type DiaTool,
  type ModelOption,
  type OutboundMessage,
  ProjectId,
  type SessionAttachment,
  SessionId,
  SessionNotice,
  SessionStarted
} from '@dia/plugin'
import type { McpServers } from '@dia-plugin/mcp/servers'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { AgentName } from '@shared/domain/project'
import { DateTime, Deferred, Effect, Exit, Option, Scope, Stream, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { makeAssistant } from './assistant'
import { EXECUTIVE_ASSISTANT } from './built-in-job-titles'
import {
  DirectRoute,
  type JobTitleId,
  type MissingReference,
  ObjectiveId,
  PlanRoute,
  WorkTitle
} from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { holdBuiltInDefinitions, mcpRegistry, skillRegistry } from './registries.fake'
import { makeSessionTools } from './session-tools'
import { makeWork } from './work'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-400000000001')
const CLAIMED = ObjectiveId.make('00000000-0000-4000-8000-500000000001')
const UNCLAIMED = ObjectiveId.make('00000000-0000-4000-8000-500000000002')
const SESSION = SessionId.make('5e551011-0000-4000-8000-000000000001')
const ASSISTANT_JOB_TITLE = EXECUTIVE_ASSISTANT.id as JobTitleId

const model = (value: string): ModelOption => ({
  value,
  displayName: value,
  description: '',
  adaptiveThinking: true,
  effortLevels: [],
  autoMode: false,
  fastMode: false
})

const TOOLS: ReadonlyArray<DiaTool> = [
  { name: 'objectives_read', description: '', input: {}, run: () => Effect.die('unused') }
]

interface Opened {
  readonly options: AgentSessionOptions
  readonly sent: Array<string>
}

interface Attached {
  readonly attachment: SessionAttachment
  readonly session: AgentSession
  readonly paneEvents: Array<OutboundMessage>
  detached: boolean
}

const fakeHost = () => {
  const opened: Array<Opened> = []
  const attachments: Array<Attached> = []
  const backend = {
    openSession: (options: AgentSessionOptions) =>
      Effect.sync(() => {
        const entry: Opened = { options, sent: [] }
        opened.push(entry)
        return {
          sendText: (text: string) => Effect.sync(() => entry.sent.push(text))
        } as unknown as AgentSession
      }),
    models: () =>
      Stream.make({
        _tag: 'Ready',
        models: [model('default'), model('opus')],
        fetchedAt: DateTime.makeUnsafe(0),
        refreshing: false
      })
  } as unknown as AgentBackend
  const attach = (attachment: SessionAttachment) =>
    Effect.gen(function* () {
      const paneEvents: Array<OutboundMessage> = []
      const session = yield* attachment.open((message) =>
        Effect.sync(() => paneEvents.push(message))
      )
      const attached: Attached = { attachment, session, paneEvents, detached: false }
      attachments.push(attached)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          attached.detached = true
        })
      )
    })
  const shown = () => attachments.filter((attached) => !attached.detached)
  return { backend, attach, opened, attachments, shown }
}

const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow
})

const GITHUB: McpServers[string] = { type: 'http', url: 'https://example.com/mcp', headers: {} }

const setUpWith = (options: { readonly settled: boolean }) =>
  Effect.gen(function* () {
    const dbScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(dbScope, Exit.void))
    const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(dbScope))
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provide(NodeCrypto.layer))
    const { work, runs, org } = yield* provide(
      Effect.gen(function* () {
        const made = yield* makeWork(() => Effect.succeed(true))
        return { ...made, org: yield* makeOrg(made.openIssuesOf) }
      })
    )
    yield* holdBuiltInDefinitions(org)
    const pluginsSettled = yield* Deferred.make<void>()
    if (options.settled) yield* Deferred.succeed(pluginsSettled, undefined)
    const sessionTools = yield* makeSessionTools(Deferred.await(pluginsSettled))
    const mcp = yield* mcpRegistry()
    yield* sessionTools.holdMcp(mcp.registry)
    yield* sessionTools.holdSkills(yield* skillRegistry('user', []))
    const missing = yield* SubscriptionRef.make<ReadonlyArray<MissingReference>>([])
    const host = fakeHost()
    const start = Effect.gen(function* () {
      const scope = yield* Scope.make()
      const assistant = yield* provide(
        makeAssistant({
          org,
          work,
          backend: host.backend,
          tools: () => TOOLS,
          attach: host.attach,
          directory: 'C:/dia/plugins/org/assistant',
          sessionTools,
          missing
        })
      ).pipe(Scope.provide(scope))
      yield* settle
      return { assistant, stop: Scope.close(scope, Exit.void) }
    })
    const engineer = (yield* org.jobTitles).find(
      (jobTitle) => jobTitle.builtIn === 'software-engineer'
    )
    assert.isDefined(engineer)
    const ada = yield* org.hire(engineer.id, AgentName.make('Ada'), null)
    return { sql, work, runs, org, host, start, ada, mcp, pluginsSettled, missing }
  })

const setUp = setUpWith({ settled: true })

const startSession = (env: Effect.Success<typeof setUp>) => {
  const [opened] = env.host.opened
  assert.isDefined(opened)
  return opened.options.emit(SessionStarted.make({ sessionId: SESSION }))
}

describe('Assistant session', () => {
  it.effect(
    'attaches one session in the Assistant group that runs the routing tools without asking',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp
        yield* env.start

        const [attached] = env.host.shown()
        assert.isDefined(attached)
        const { display, resume } = attached.attachment
        const [opened] = env.host.opened
        assert.isDefined(opened)
        assert.deepStrictEqual(
          {
            count: env.host.shown().length,
            projectId: display.projectId,
            label: display.label,
            caption: display.caption,
            cwd: display.config.cwd,
            permissionMode: display.config.permissionMode,
            model: display.config.model,
            resettable: Option.isSome(attached.attachment.reset),
            resumed: Option.isSome(resume),
            tools: opened.options.diaTools,
            allow: Option.map(opened.options.tools, (tools) => tools.permissions.allow)
          },
          {
            count: 1,
            projectId: null as ProjectId | null,
            label: 'Executive assistant',
            caption: '',
            cwd: 'C:/dia/plugins/org/assistant',
            permissionMode: 'dontAsk',
            model: 'default',
            resettable: true,
            resumed: false,
            tools: TOOLS,
            allow: Option.some<ReadonlyArray<string>>(EXECUTIVE_ASSISTANT.allow)
          }
        )
      }).pipe(Effect.scoped)
  )

  it.effect('resumes the session it started, in the same pane, after a restart', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const first = yield* env.start
      const [before] = env.host.shown()
      assert.isDefined(before)
      yield* startSession(env)
      yield* first.stop
      yield* env.start

      const [after] = env.host.shown()
      assert.isDefined(after)
      assert.deepStrictEqual(
        [after.attachment.display.config.paneId, after.attachment.resume],
        [before.attachment.display.config.paneId, Option.some(SESSION)]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('closes the session when the built-in is disabled and attaches it when enabled', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.start

      yield* env.org.setJobTitleEnabled(ASSISTANT_JOB_TITLE, false)
      yield* settle
      const whileDisabled = env.host.shown().length
      yield* env.org.setJobTitleEnabled(ASSISTANT_JOB_TITLE, true)
      yield* settle

      assert.deepStrictEqual([whileDisabled, env.host.shown().length], [0, 1])
    }).pipe(Effect.scoped)
  )

  it.effect('keeps the running session open when the built-in is edited', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.start

      yield* env.org.editJobTitle(ASSISTANT_JOB_TITLE, { thinkingLevel: 'high' })
      yield* settle

      assert.deepStrictEqual([env.host.attachments.length, env.host.shown().length], [1, 1])
    }).pipe(Effect.scoped)
  )

  it.effect('attaches nothing while the built-in is disabled at start', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.org.setJobTitleEnabled(ASSISTANT_JOB_TITLE, false)
      yield* env.start

      assert.strictEqual(env.host.attachments.length, 0)
    }).pipe(Effect.scoped)
  )

  it.effect('returns from setup while the model catalog is not ready', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      Object.assign(env.host.backend, { models: () => Stream.never })

      const started = yield* env.start.pipe(Effect.timeoutOption('1 second'))

      assert.isTrue(Option.isSome(started))
      assert.strictEqual(env.host.attachments.length, 0)
    }).pipe(Effect.scoped)
  )

  it.effect('starts over in a new pane with no session to resume', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const { assistant } = yield* env.start
      yield* startSession(env)
      const [before] = env.host.shown()
      assert.isDefined(before)

      yield* assistant.startOver

      const shown = env.host.shown()
      assert.deepStrictEqual(
        [
          before.detached,
          shown.length,
          shown[0]?.attachment.display.config.paneId === before.attachment.display.config.paneId,
          shown[0]?.attachment.resume
        ],
        [true, 1, false, Option.none()]
      )
    }).pipe(Effect.scoped)
  )
})

describe('Assistant notices', () => {
  const createDirect = (env: Effect.Success<typeof setUp>, id: ObjectiveId) =>
    env.work.createObjective({
      id,
      projectId: PROJECT,
      title: WorkTitle.make('Fix the typo in the README'),
      description: 'fix the typo in the README',
      priority: 'normal',
      route: DirectRoute.make({ assignee: env.ada.id })
    })

  const startedIssue = (env: Effect.Success<typeof setUp>, objectiveId: ObjectiveId) =>
    Effect.gen(function* () {
      const issue = (yield* env.work.snapshot).issues.find(
        (entry) => entry.objectiveId === objectiveId
      )
      assert.isDefined(issue)
      assert.isTrue(yield* env.runs.markStarted(issue.id, env.ada.id))
      return issue
    })

  const notices = (env: Effect.Success<typeof setUp>) =>
    env.host
      .shown()
      .flatMap((attached) => attached.paneEvents)
      .filter((event) => event._tag === 'SessionNotice')

  it.effect(
    'shows an Open notice when an issue of a claimed objective reaches review, and sends its text with the next message',
    () =>
      Effect.gen(function* () {
        const env = yield* setUp
        const { assistant } = yield* env.start
        yield* assistant.claim(CLAIMED)
        yield* createDirect(env, CLAIMED)
        const issue = yield* startedIssue(env, CLAIMED)

        yield* env.work.updateIssue(CLAIMED, issue.id, { status: 'in_review' })
        yield* settle
        const [attached] = env.host.shown()
        assert.isDefined(attached)
        yield* attached.session.sendText('what else is open?', 'queue')
        yield* attached.session.sendText('thanks', 'queue')

        assert.deepStrictEqual(
          [notices(env), env.host.opened[0]?.sent],
          [
            [
              SessionNotice.make({
                text: '"Fix the typo in the README" is in review.',
                link: { label: 'Open', plugin: 'org', page: 'org', target: CLAIMED }
              })
            ],
            ['"Fix the typo in the README" is in review.\nwhat else is open?', 'thanks']
          ]
        )
      }).pipe(Effect.scoped)
  )

  it.effect('notices a claimed objective completing', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const { assistant } = yield* env.start
      yield* assistant.claim(CLAIMED)
      yield* createDirect(env, CLAIMED)
      yield* settle

      yield* env.work.stopObjective(CLAIMED)
      yield* settle

      assert.deepStrictEqual(
        notices(env).map((notice) => notice.text),
        ['Objective "Fix the typo in the README" is completed.']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('notices an issue of a claimed objective entering triage', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const { assistant } = yield* env.start
      yield* assistant.claim(CLAIMED)
      yield* createDirect(env, CLAIMED)
      yield* settle

      yield* env.work.proposeIssue(CLAIMED, {
        parentIssueId: null,
        title: WorkTitle.make('Fix the typo in CONTRIBUTING'),
        description: 'Same typo.'
      })
      yield* settle

      assert.deepStrictEqual(
        notices(env).map((notice) => notice.text),
        ['"Fix the typo in CONTRIBUTING" needs triage.']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('gives no notice for an objective the assistant did not create', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.start
      yield* env.work.createObjective({
        id: UNCLAIMED,
        projectId: PROJECT,
        title: WorkTitle.make('Ship the marketplace'),
        description: 'Let users install plugins.',
        priority: 'normal',
        route: PlanRoute.make({ assignee: env.ada.id })
      })
      const issue = yield* startedIssue(env, UNCLAIMED)

      yield* env.work.updateIssue(UNCLAIMED, issue.id, { status: 'in_review' })
      yield* settle

      assert.deepStrictEqual(notices(env), [])
    }).pipe(Effect.scoped)
  )

  it.effect('drops the pending notice texts when it starts over', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const { assistant } = yield* env.start
      yield* assistant.claim(CLAIMED)
      yield* createDirect(env, CLAIMED)
      const issue = yield* startedIssue(env, CLAIMED)
      yield* env.work.updateIssue(CLAIMED, issue.id, { status: 'in_review' })
      yield* settle

      yield* assistant.startOver
      const [fresh] = env.host.shown()
      assert.isDefined(fresh)
      yield* fresh.session.sendText('hello', 'queue')

      assert.deepStrictEqual(env.host.opened[1]?.sent, ['hello'])
    }).pipe(Effect.scoped)
  )
})

const GITHUB_MISSING: ReadonlyArray<MissingReference> = [{ kind: 'mcp-server', name: 'github' }]

const assistantNaming = (env: Effect.Success<typeof setUp>, servers: ReadonlyArray<string>) =>
  env.org.editJobTitle(ASSISTANT_JOB_TITLE, { mcpServers: servers })

describe('Assistant with missing names', () => {
  it.effect('stays detached and reports the missing server once plugins settle', () =>
    Effect.gen(function* () {
      const env = yield* setUpWith({ settled: false })
      yield* assistantNaming(env, ['github'])
      yield* env.start
      const beforeSettled = yield* SubscriptionRef.get(env.missing)

      yield* Deferred.succeed(env.pluginsSettled, undefined)
      yield* settle

      assert.deepStrictEqual(
        [beforeSettled, yield* SubscriptionRef.get(env.missing), env.host.attachments.length],
        [[], GITHUB_MISSING, 0]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('attaches and clears the missing names once the server is registered', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* assistantNaming(env, ['github'])
      yield* env.start

      yield* env.mcp.replaceUser({ github: GITHUB }, Effect.void)
      yield* settle

      const [opened] = env.host.opened
      assert.deepStrictEqual(
        [
          env.host.shown().length,
          yield* SubscriptionRef.get(env.missing),
          Option.map(opened?.options.tools ?? Option.none(), (tools) => tools.mcpServers)
        ],
        [1, [], Option.some({ github: GITHUB })]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('detaches when a server it names is deleted while attached', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.mcp.replaceUser({ github: GITHUB }, Effect.void)
      yield* assistantNaming(env, ['github'])
      yield* env.start
      const attachedBefore = env.host.shown().length

      yield* env.mcp.replaceUser({}, Effect.void)
      yield* settle

      assert.deepStrictEqual(
        [attachedBefore, env.host.shown().length, yield* SubscriptionRef.get(env.missing)],
        [1, 0, GITHUB_MISSING]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('keeps the stored session when asked to start over while a name is missing', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const { assistant } = yield* env.start
      yield* startSession(env)
      const before = yield* env.sql<{
        readonly pane_id: string
        readonly session_id: string | null
      }>`SELECT pane_id, session_id FROM assistant_session`
      yield* assistantNaming(env, ['github'])
      yield* settle

      yield* assistant.startOver

      const after = yield* env.sql<{
        readonly pane_id: string
        readonly session_id: string | null
      }>`SELECT pane_id, session_id FROM assistant_session`
      assert.deepStrictEqual([after, after[0]?.session_id], [before, SESSION])
    }).pipe(Effect.scoped)
  )
})

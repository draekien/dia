import {
  type DiaTool,
  type GitOps,
  type HostPluginContext,
  type Runs,
  RunsKey,
  type ToolScope,
  WorktreeReleased,
  WorktreesKey
} from '@dia/plugin'
import agentDefinitionsSetup from '@dia-plugin/dia-agent-definitions/host'
import { IssuesView } from '@dia-plugin/dia-issues/calls'
import issuesSetup from '@dia-plugin/dia-issues/host'
import mcpSetup from '@dia-plugin/dia-mcp/host'
import { RunQueueKey } from '@dia-plugin/dia-run-queue/queue'
import { type AgentBackend, AgentBackendKey } from '@dia-plugin/dia-runs/backend'
import { ToolsKey } from '@dia-plugin/dia-tools/tools'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { DateTime, Duration, Effect, FileSystem, Option, Path, Schema, Stream } from 'effect'
import {
  callPlugin,
  servePluginCall,
  subscribePlugin
} from '../../src/host/plugins/plugin-messages'
import { makePluginDatabase } from '../../src/host/services/database'
import {
  BUILT_IN_JOB_TITLES,
  DEFAULT_OVERALL_CAP,
  EXECUTIVE_ASSISTANT
} from './built-in-job-titles'
import { OrgLive, OrgSnapshot } from './calls'
import { HiredAgent } from './domain'
import setup from './host'
import { ISSUE_RUN_LABEL } from './issue-runs'
import { fakeRuns } from './runs.fake'

const UNKNOWN_HIRE = '00000000-0000-4000-8000-000000000000'

const manifest = (name: string): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const PROJECT_ID = '00000000-0000-4000-8000-400000000001'

const READY = {
  _tag: 'Ready',
  models: [
    {
      value: 'default',
      displayName: 'Default',
      description: '',
      adaptiveThinking: true,
      effortLevels: [],
      autoMode: false,
      fastMode: false
    }
  ],
  fetchedAt: DateTime.makeUnsafe(0),
  refreshing: false
}

const backendDisabling = (modes: ReadonlyArray<string>) =>
  ({
    openSession: () => Effect.die('org opens no session'),
    readHistory: () => Effect.die('not called'),
    transcriptInfo: () => Effect.die('not called'),
    readTranscriptAfter: () => Effect.die('not called'),
    models: () => Stream.make(READY),
    refreshModels: () => Effect.die('not called'),
    status: () => Effect.die('not called'),
    checkHealth: () => Effect.die('not called'),
    setInstallPath: () => Effect.die('not called'),
    disabledPermissionModes: () => Effect.succeed(modes),
    attachmentTypes: () => Effect.die('not called')
  }) as unknown as AgentBackend

const fakeGitOps = (log: Array<string>): GitOps => ({
  createWorktree: (repo, owner) =>
    Effect.sync(() => {
      log.push(`create ${owner.label}`)
      return { path: 'C:/trees/one', branch: 'dia/one', sourceRepo: repo }
    }),
  reattachWorktree: (info) => Effect.succeed(info),
  releaseWorktree: () => Effect.succeed(WorktreeReleased.make({})),
  findIncludedFiles: () => Effect.succeed(Option.none()),
  copyIncludedFiles: () => Effect.succeed([])
})

interface Registered {
  readonly tool: DiaTool
  readonly when: (scope: ToolScope) => boolean
}

const fakeFoundation = () => {
  const fake = fakeRuns()
  const limits: Array<number> = []
  const tools: Array<Registered> = []
  const ignored = () => Effect.void
  const runs = {
    ...fake.runs,
    open: () => Effect.die('not called'),
    editQueued: ignored,
    removeQueued: ignored,
    sendQueuedNow: ignored,
    answer: ignored,
    requests: Stream.make([]),
    busy: Stream.make([]),
    interrupt: ignored,
    resumeParked: ignored,
    rewind: ignored,
    setThinkingLevel: ignored,
    setPermissionMode: ignored,
    setModel: ignored,
    awaitIdle: ignored,
    isLive: () => Effect.succeed(false),
    openInTab: ignored,
    changes: Stream.empty,
    discoverSessions: () => Effect.succeed([])
  } as unknown as Runs
  const setup = (ctx: HostPluginContext) =>
    Effect.gen(function* () {
      yield* ctx.provide(RunsKey, runs)
      yield* ctx.provide(RunQueueKey, {
        enqueue: fake.queue.enqueue,
        setLimit: (limit) => Effect.sync(() => void limits.push(limit))
      })
      yield* ctx.provide(ToolsKey, {
        register: (tool, options) =>
          Effect.acquireRelease(
            Effect.sync(() => void tools.push({ tool, when: options.when })),
            () =>
              Effect.sync(
                () =>
                  void tools.splice(
                    tools.findIndex((t) => t.tool === tool),
                    1
                  )
              )
          ),
        forScope: () => Effect.succeed([]),
        grant: ignored,
        revoke: ignored,
        url: 'http://127.0.0.1:1/mcp',
        mcpServer: () => Effect.die('not called')
      })
    })
  return { fake, limits, tools, setup }
}

const startOrg = (
  backend: Option.Option<AgentBackend>,
  gitOps: Option.Option<GitOps> = Option.none(),
  foundation: Option.Option<ReturnType<typeof fakeFoundation>> = Option.none()
) =>
  Effect.gen(function* () {
    const dataRoot = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
    const setups: Record<string, (ctx: HostPluginContext) => Effect.Effect<void, never, never>> = {
      org: setup as never,
      'agent-definitions': agentDefinitionsSetup as never,
      mcp: mcpSetup as never,
      issues: issuesSetup as never
    }
    if (Option.isSome(gitOps)) {
      setups.worktrees = ((ctx: HostPluginContext) =>
        ctx.provide(WorktreesKey, gitOps.value)) as never
    }
    if (Option.isSome(foundation)) setups.foundation = foundation.value.setup as never
    if (Option.isSome(backend)) {
      setups.backend = ((ctx: HostPluginContext) =>
        ctx.provide(AgentBackendKey, backend.value)) as never
    }
    const registry = yield* makePluginRegistry<HostPluginContext>({
      catalog: {
        names: () => Effect.succeed(Object.keys(setups)),
        resolve: (name) => Effect.succeed(Option.some({ root: name, origin: 'default' as const }))
      },
      loader: {
        peek: (name) => Effect.succeed(manifest(name)),
        load: (name, _root, use) =>
          use({
            manifest: manifest(name),
            resolveSetup: Effect.succeed(Option.fromNullishOr(setups[name])),
            importers: []
          })
      },
      extend: (services) => {
        const served = new Set<string>()
        const serve: HostPluginContext['serve'] = (rpc, handler) =>
          servePluginCall(services, served, rpc, handler)
        return Effect.succeed({
          ...services,
          database: makePluginDatabase(':memory:', services.name),
          pluginsSettled: Effect.void,
          workspace: Stream.make({
            projects: [
              {
                project: {
                  projectId: PROJECT_ID,
                  directory: 'F:/repos/app',
                  directoryKey: 'f:/repos/app',
                  displayName: 'app',
                  isGitRepo: true
                },
                tabs: []
              }
            ],
            visibleTab: null
          }),
          onPathsMoved: () => Effect.void,
          dataDir: `${dataRoot}/${services.name}`,
          serve
        } as unknown as HostPluginContext)
      }
    })
    yield* registry.load('agent-definitions')
    yield* registry.load('mcp')
    yield* registry.load('org')
    yield* registry.load('issues')
    return registry
  }).pipe(Effect.provide(NodeServices.layer))

let calls = 0
const attempt = () => {
  calls += 1
  return { id: `call-${calls}`, resent: false }
}

const call = (registry: PluginRegistry, tag: string, payload: unknown) =>
  callPlugin(registry, { plugin: 'org', tag, payload, call: attempt() })

const readOrg = (registry: PluginRegistry) =>
  call(registry, 'ReadOrg', {}).pipe(Effect.map(Schema.decodeUnknownSync(OrgSnapshot)))

const bypassAvailable = (registry: PluginRegistry) =>
  Effect.map(readOrg(registry), (snapshot) => snapshot.bypassAvailable)

describe('org host entry', () => {
  it.effect('reads the seeded org: every built-in job title, no hires and the default cap', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.none())

      const snapshot = yield* readOrg(registry)

      assert.deepStrictEqual(
        {
          jobTitles: snapshot.jobTitles.map((jobTitle) => jobTitle.id),
          hires: snapshot.hiredAgents.map((hire) => hire.id),
          cap: snapshot.settings.overallCap
        },
        {
          jobTitles: [...BUILT_IN_JOB_TITLES.map((seed) => seed.id), EXECUTIVE_ASSISTANT.id],
          hires: [],
          cap: DEFAULT_OVERALL_CAP
        }
      )
    })
  )

  it.effect('applies a change sent as a call, so the next read shows it', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.none())
      const hired = Schema.decodeUnknownSync(HiredAgent)(
        yield* call(registry, 'Hire', {
          jobTitleId: BUILT_IN_JOB_TITLES[0]?.id,
          name: null,
          reportsTo: null
        })
      )

      yield* call(registry, 'RenameHire', { hireId: hired.id, name: 'calm-heron' })
      yield* call(registry, 'SetBypassOverride', { hireId: hired.id, override: false })
      yield* call(registry, 'SetOverallCap', { cap: 6 })
      const snapshot = yield* readOrg(registry)

      assert.deepStrictEqual(
        {
          name: snapshot.hiredAgents[0]?.name,
          override: snapshot.hiredAgents[0]?.bypassOverride,
          cap: snapshot.settings.overallCap
        },
        { name: 'calm-heron', override: false, cap: 6 }
      )
    })
  )

  it.effect('serves SetReportsTo, and fails a self-report with ReportsToCycle encoded', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.none())
      const hireOne = (name: string) =>
        call(registry, 'Hire', {
          jobTitleId: BUILT_IN_JOB_TITLES[0]?.id,
          name,
          reportsTo: null
        }).pipe(Effect.map(Schema.decodeUnknownSync(HiredAgent)))
      const lead = yield* hireOne('lead')
      const report = yield* hireOne('report')

      yield* call(registry, 'SetReportsTo', { hireId: report.id, reportsTo: lead.id })
      const cycle = yield* Effect.flip(
        call(registry, 'SetReportsTo', { hireId: lead.id, reportsTo: lead.id })
      )
      const snapshot = yield* readOrg(registry)

      assert.deepStrictEqual(
        {
          reportsTo: snapshot.hiredAgents.find((hire) => hire.id === report.id)?.reportsTo,
          error: cycle._tag === 'PluginCallFailed' ? cycle.error : undefined
        },
        {
          reportsTo: lead.id,
          error: { _tag: 'ReportsToCycle', hireId: lead.id, reportsTo: lead.id }
        }
      )
    })
  )

  it.effect("fails a call with the org's typed error, encoded", () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.none())

      const error = yield* Effect.flip(call(registry, 'Dismiss', { hireId: UNKNOWN_HIRE }))

      assert.deepStrictEqual(
        { tag: error._tag, error: error._tag === 'PluginCallFailed' ? error.error : undefined },
        { tag: 'PluginCallFailed', error: { _tag: 'HireNotFound', hireId: UNKNOWN_HIRE } }
      )
    })
  )
})

describe('org host entry bypassAvailable', () => {
  it.effect('is false while no agent backend is provided', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.none())

      assert.isFalse(yield* bypassAvailable(registry))
    })
  )

  it.effect('is true when the backend leaves bypassPermissions enabled', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.some(backendDisabling(['plan'])))
      yield* registry.load('backend')

      assert.isTrue(yield* bypassAvailable(registry))
    })
  )

  it.effect('is false when the backend disables bypassPermissions', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.some(backendDisabling(['bypassPermissions'])))
      yield* registry.load('backend')

      assert.isFalse(yield* bypassAvailable(registry))
    })
  )

  it.effect('follows a backend provided after the org loaded, and withdrawn later', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.some(backendDisabling([])))
      const before = yield* bypassAvailable(registry)

      yield* registry.load('backend')
      const provided = yield* bypassAvailable(registry)
      yield* registry.unload('backend')
      const withdrawn = yield* bypassAvailable(registry)

      assert.deepStrictEqual([before, provided, withdrawn], [false, true, false])
    })
  )
})

describe('org host entry work through issues', () => {
  const OBJECTIVE_ID = '00000000-0000-4000-8000-500000000001'
  const issueId = (n: number) => `00000000-0000-4000-8000-60000000000${n}`

  const settle = Effect.gen(function* () {
    for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow
  })

  const callIssues = (registry: PluginRegistry, tag: string, payload: unknown) =>
    callPlugin(registry, { plugin: 'issues', tag, payload, call: attempt() })

  const hireEngineer = (registry: PluginRegistry) =>
    Effect.map(
      call(registry, 'Hire', {
        jobTitleId: BUILT_IN_JOB_TITLES[1]?.id,
        name: null,
        reportsTo: null
      }),
      (hired) => Schema.decodeUnknownSync(HiredAgent)(hired).id
    )

  const createObjective = (registry: PluginRegistry) =>
    callIssues(registry, 'CreateObjective', {
      objective: {
        id: OBJECTIVE_ID,
        projectId: PROJECT_ID,
        title: 'Ship it',
        description: '',
        priority: 'normal',
        assignee: null
      }
    })

  const orgRef = (hireId: string) => ({ provider: 'org', id: hireId })

  const createIssue = (registry: PluginRegistry, n: number, hireId: string | null) =>
    callIssues(registry, 'CreateIssue', {
      issue: {
        id: issueId(n),
        objectiveId: OBJECTIVE_ID,
        parentIssueId: null,
        title: `Issue ${n}`,
        description: '',
        assignee: hireId === null ? null : orgRef(hireId)
      }
    })

  const readIssues = (registry: PluginRegistry) =>
    Effect.map(callIssues(registry, 'ReadIssues', {}), (value) =>
      Schema.decodeUnknownSync(IssuesView)(value)
    )

  const statusOf = (registry: PluginRegistry, n: number) =>
    Effect.map(
      readIssues(registry),
      (view) => view.issues.find((issue) => issue.id === issueId(n))?.status
    )

  const liveWhere = (registry: PluginRegistry, done: (live: OrgLive) => boolean) =>
    Effect.gen(function* () {
      const stream = yield* subscribePlugin(registry, {
        plugin: 'org',
        tag: 'WatchOrgLive',
        payload: {}
      })
      const found = yield* stream.pipe(
        Stream.map((value) => Schema.decodeUnknownSync(OrgLive)(value)),
        Stream.filter(done),
        Stream.runHead,
        Effect.timeout(Duration.seconds(5))
      )
      return Option.getOrThrow(found)
    })

  it.live('reports team work once a hire has an open issue, and none once issues unloads', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.none())
      yield* createObjective(registry)
      const ada = yield* hireEngineer(registry)
      yield* createIssue(registry, 1, null)
      const unassigned = yield* liveWhere(registry, () => true)

      yield* createIssue(registry, 2, ada)
      const assigned = yield* liveWhere(registry, (live) => live.teamHasWork)
      yield* registry.unload('issues')
      const unloaded = yield* liveWhere(registry, (live) => !live.teamHasWork)

      assert.deepStrictEqual(
        [unassigned.teamHasWork, assigned.teamHasWork, unloaded.teamHasWork],
        [false, true, false]
      )
    })
  )

  const startWithFoundation = Effect.gen(function* () {
    const foundation = fakeFoundation()
    const registry = yield* startOrg(
      Option.some(backendDisabling([])),
      Option.none(),
      Option.some(foundation)
    )
    yield* registry.load('backend')
    yield* registry.load('foundation')
    yield* createObjective(registry)
    const ada = yield* hireEngineer(registry)
    yield* settle
    return { registry, foundation, ada }
  })

  it.effect('queues an issue assigned to a hire under its hire key, and starts it', () =>
    Effect.gen(function* () {
      const { registry, foundation, ada } = yield* startWithFoundation

      yield* createIssue(registry, 1, ada)
      yield* settle
      const [queued] = foundation.fake.enqueued
      assert.isDefined(queued)
      yield* queued.start('run-1')
      yield* settle

      assert.deepStrictEqual(
        [queued.entry.key, queued.entry.run.context, yield* statusOf(registry, 1)],
        [{ id: ada, limit: 1 }, { issueId: issueId(1), assigneeId: ada }, 'understanding']
      )
    })
  )

  it.effect("gives an issue run's update_issue the issue and hire from its tool scope", () =>
    Effect.gen(function* () {
      const { registry, foundation, ada } = yield* startWithFoundation
      yield* createIssue(registry, 1, ada)
      yield* settle
      yield* foundation.fake.enqueued[0]?.start('run-1') ?? Effect.void
      yield* settle
      const scope: ToolScope = {
        runId: 'run-1',
        labels: [ISSUE_RUN_LABEL],
        context: { issueId: issueId(1), assigneeId: ada }
      }
      const update = foundation.tools.find(
        (entry) => entry.tool.name === 'update_issue' && entry.when(scope)
      )
      assert.isDefined(update)

      const result = yield* update.tool.run({ status: 'implementing' }, scope)

      assert.isFalse(result.isError, result.text)
      assert.strictEqual(yield* statusOf(registry, 1), 'implementing')
    })
  )

  it.effect('offers the issue tools only to runs with an issue context', () =>
    Effect.gen(function* () {
      const { foundation } = yield* startWithFoundation
      const outside: ToolScope = { labels: [], context: null }

      const offered = foundation.tools.filter((entry) => entry.when(outside))

      assert.deepStrictEqual(
        offered.map((entry) => entry.tool.name),
        []
      )
    })
  )

  it.effect('offers the routing tools to the Executive assistant run only', () =>
    Effect.gen(function* () {
      const { foundation } = yield* startWithFoundation
      const assistant: ToolScope = { runId: 'run-a', labels: ['dia-org-assistant'], context: null }

      const offered = foundation.tools.filter((entry) => entry.when(assistant))

      assert.deepStrictEqual(offered.map((entry) => entry.tool.name).sort(), [
        'objective_attach',
        'objective_create',
        'objective_stop',
        'objectives_read'
      ])
    })
  )

  it.effect('sets the run queue limit to the overall cap, and again when the cap changes', () =>
    Effect.gen(function* () {
      const { registry, foundation } = yield* startWithFoundation

      yield* call(registry, 'SetOverallCap', { cap: 2 })

      assert.deepStrictEqual(foundation.limits, [DEFAULT_OVERALL_CAP, 2])
    })
  )

  it.effect('starts the Executive assistant run on the first request', () =>
    Effect.gen(function* () {
      const { registry, foundation } = yield* startWithFoundation

      const runId = yield* call(registry, 'AskAssistant', { text: 'Add dark mode' })

      assert.deepStrictEqual(
        [runId, foundation.fake.started.map((run) => run.labels)],
        ['run-1', [['dia-org-assistant']]]
      )
    })
  )
})

describe('dia-org sources', () => {
  it.effect('call no AgentBackend.openSession', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const files = yield* fs.readDirectory(import.meta.dirname)
      const sources = files.filter(
        (file) => /[.]tsx?$/.test(file) && !/[.](test|fake)[.]tsx?$/.test(file)
      )
      const calling = yield* Effect.filter(sources, (file) =>
        Effect.map(fs.readFileString(path.join(import.meta.dirname, file)), (text) =>
          text.includes('openSession')
        )
      )

      assert.isAbove(sources.length, 10)
      assert.deepStrictEqual(calling, [])
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

describe('org host entry issue worktrees', () => {
  const OBJECTIVE_ID = '00000000-0000-4000-8000-500000000001'
  const settle = Effect.gen(function* () {
    for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow
  })
  const callIssues = (registry: PluginRegistry, tag: string, payload: unknown) =>
    callPlugin(registry, { plugin: 'issues', tag, payload, call: attempt() })

  it.effect('lists a project the switch is on for, and a switch that is turned off is gone', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.none())

      yield* call(registry, 'SetProjectWorktrees', { projectId: PROJECT_ID, enabled: true })
      const on = (yield* readOrg(registry)).worktreeProjects
      yield* call(registry, 'SetProjectWorktrees', { projectId: PROJECT_ID, enabled: false })

      assert.deepStrictEqual([on, (yield* readOrg(registry)).worktreeProjects], [[PROJECT_ID], []])
    })
  )

  it.effect('queues the issue in its own worktree once the worktrees plugin is provided', () =>
    Effect.gen(function* () {
      const foundation = fakeFoundation()
      const log: Array<string> = []
      const registry = yield* startOrg(
        Option.some(backendDisabling([])),
        Option.some(fakeGitOps(log)),
        Option.some(foundation)
      )
      yield* registry.load('backend')
      yield* registry.load('foundation')
      yield* call(registry, 'SetProjectWorktrees', { projectId: PROJECT_ID, enabled: true })
      yield* callIssues(registry, 'CreateObjective', {
        objective: {
          id: OBJECTIVE_ID,
          projectId: PROJECT_ID,
          title: 'Ship it',
          description: '',
          priority: 'normal',
          assignee: null
        }
      })
      const hire = Schema.decodeUnknownSync(HiredAgent)(
        yield* call(registry, 'Hire', {
          jobTitleId: BUILT_IN_JOB_TITLES[1]?.id,
          name: null,
          reportsTo: null
        })
      )
      yield* settle
      yield* callIssues(registry, 'CreateIssue', {
        issue: {
          id: '00000000-0000-4000-8000-600000000001',
          objectiveId: OBJECTIVE_ID,
          parentIssueId: null,
          title: 'Fix login',
          description: '',
          assignee: { provider: 'org', id: hire.id }
        }
      })
      yield* settle
      const before = foundation.fake.enqueued.length

      yield* registry.load('worktrees')
      yield* callIssues(registry, 'AssignIssue', {
        issueId: '00000000-0000-4000-8000-600000000001',
        assignee: { provider: 'org', id: hire.id }
      })
      yield* settle

      assert.deepStrictEqual(
        [before, foundation.fake.enqueued.map((queued) => queued.entry.run.cwd), log],
        [0, ['C:/trees/one'], ['create Issue · Fix login']]
      )
    })
  )
})

import {
  type AgentBackend,
  AgentBackendKey,
  type AgentSessionOptions,
  type HostPluginContext,
  type SessionAttachment
} from '@dia/plugin'
import agentDefinitionsSetup from '@dia-plugin/agent-definitions/host'
import { IssuesView } from '@dia-plugin/issues/calls'
import issuesSetup from '@dia-plugin/issues/host'
import mcpSetup from '@dia-plugin/mcp/host'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { DateTime, Effect, Option, Schema, Stream } from 'effect'
import { callPlugin, servePluginCall } from '../../src/host/plugins/plugin-messages'
import { makePluginDatabase } from '../../src/host/services/database'
import {
  BUILT_IN_JOB_TITLES,
  DEFAULT_OVERALL_CAP,
  EXECUTIVE_ASSISTANT
} from './built-in-job-titles'
import { OrgSnapshot } from './calls'
import { HiredAgent } from './domain'
import setup from './host'

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

const backendDisabling = (modes: ReadonlyArray<string>, opened: Array<string> = []) =>
  ({
    openSession: (options: AgentSessionOptions) =>
      Effect.sync(() => {
        opened.push(options.config.paneId)
        return { sendText: () => Effect.void, ended: Effect.never }
      }),
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

const startOrg = (backend: Option.Option<AgentBackend>) =>
  Effect.gen(function* () {
    const setups: Record<string, (ctx: HostPluginContext) => Effect.Effect<void, never, never>> = {
      org: setup as never,
      'agent-definitions': agentDefinitionsSetup as never,
      mcp: mcpSetup as never,
      issues: issuesSetup as never
    }
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
          sessions: {
            attach: (attachment: SessionAttachment) =>
              attachment.open(() => Effect.void).pipe(Effect.asVoid)
          },
          serve
        } as unknown as HostPluginContext)
      }
    })
    yield* registry.load('agent-definitions')
    yield* registry.load('mcp')
    yield* registry.load('org')
    yield* registry.load('issues')
    return registry
  })

const call = (registry: PluginRegistry, tag: string, payload: unknown) =>
  callPlugin(registry, { plugin: 'org', tag, payload })

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
    callPlugin(registry, { plugin: 'issues', tag, payload })

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

  it.effect('starts a created issue, and starts the next one once the overall cap is raised', () =>
    Effect.gen(function* () {
      const opened: Array<string> = []
      const registry = yield* startOrg(Option.some(backendDisabling([], opened)))
      yield* registry.load('backend')
      yield* call(registry, 'SetOverallCap', { cap: 1 })
      yield* createObjective(registry)
      const ada = yield* hireEngineer(registry)
      const ben = yield* hireEngineer(registry)
      yield* settle

      yield* createIssue(registry, 1, ada)
      yield* createIssue(registry, 2, ben)
      yield* settle
      const atCapOne = opened.length
      yield* call(registry, 'SetOverallCap', { cap: 2 })
      yield* settle

      assert.deepStrictEqual([atCapOne, opened.length], [1, 2])
    })
  )

  it.effect('keeps a started issue on one session when its assignment is repeated', () =>
    Effect.gen(function* () {
      const opened: Array<string> = []
      const registry = yield* startOrg(Option.some(backendDisabling([], opened)))
      yield* registry.load('backend')
      yield* createObjective(registry)
      const ada = yield* hireEngineer(registry)
      yield* settle
      yield* createIssue(registry, 1, ada)
      yield* settle

      yield* callIssues(registry, 'AssignIssue', { issueId: issueId(1), assignee: orgRef(ada) })
      yield* settle

      assert.deepStrictEqual([yield* statusOf(registry, 1), opened.length], ['understanding', 1])
    })
  )

  it.effect('starts an unassigned todo issue once it is assigned to a hire', () =>
    Effect.gen(function* () {
      const opened: Array<string> = []
      const registry = yield* startOrg(Option.some(backendDisabling([], opened)))
      yield* registry.load('backend')
      yield* createObjective(registry)
      const ada = yield* hireEngineer(registry)
      yield* createIssue(registry, 1, null)
      yield* settle
      const beforeAssign = [yield* statusOf(registry, 1), opened.length]

      yield* callIssues(registry, 'AssignIssue', { issueId: issueId(1), assignee: orgRef(ada) })
      yield* settle

      assert.deepStrictEqual(
        [beforeAssign, [yield* statusOf(registry, 1), opened.length]],
        [
          ['todo', 0],
          ['understanding', 1]
        ]
      )
    })
  )

  it.effect('finishes a started issue to done with no retro, and frees its slot', () =>
    Effect.gen(function* () {
      const opened: Array<string> = []
      const registry = yield* startOrg(Option.some(backendDisabling([], opened)))
      yield* registry.load('backend')
      yield* call(registry, 'SetOverallCap', { cap: 1 })
      yield* createObjective(registry)
      const ada = yield* hireEngineer(registry)
      const ben = yield* hireEngineer(registry)
      yield* settle
      yield* createIssue(registry, 1, ada)
      yield* createIssue(registry, 2, ben)
      yield* settle

      yield* callIssues(registry, 'FinishIssue', { issueId: issueId(1) })
      yield* settle

      const view = yield* readIssues(registry)
      assert.deepStrictEqual(
        {
          issues: view.issues.map((issue) => [issue.kind, issue.status]),
          opened: opened.length
        },
        {
          issues: [
            ['work', 'done'],
            ['work', 'understanding']
          ],
          opened: 2
        }
      )
    })
  )
})

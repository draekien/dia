import {
  type AgentBackend,
  AgentBackendKey,
  type AgentSessionOptions,
  type HostPluginContext
} from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { DateTime, Effect, Option, Schema, Stream } from 'effect'
import {
  callPlugin,
  servePluginCall,
  subscribePlugin
} from '../../src/host/plugins/plugin-messages'
import { makePluginDatabase } from '../../src/host/services/database'
import { BUILT_IN_JOB_TITLES, DEFAULT_OVERALL_CAP } from './built-in-job-titles'
import { OrgSnapshot, WorkView } from './calls'
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
      org: setup as never
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
          serve
        } as unknown as HostPluginContext)
      }
    })
    yield* registry.load('org')
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
          jobTitles: BUILT_IN_JOB_TITLES.map((seed) => seed.id),
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

describe('org host entry work calls', () => {
  const settle = Effect.gen(function* () {
    for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow
  })

  const hireEngineer = (registry: PluginRegistry) =>
    Effect.map(
      call(registry, 'Hire', {
        jobTitleId: BUILT_IN_JOB_TITLES[1]?.id,
        name: null,
        reportsTo: null
      }),
      (hired) => Schema.decodeUnknownSync(HiredAgent)(hired).id
    )

  const createTask = (registry: PluginRegistry, n: number, assignee: string) =>
    call(registry, 'CreateTask', {
      task: {
        id: `00000000-0000-4000-8000-60000000000${n}`,
        objectiveId: '00000000-0000-4000-8000-500000000001',
        parentTaskId: null,
        title: `Task ${n}`,
        assignee
      }
    })

  it.effect('starts a created task, and starts the next one once the overall cap is raised', () =>
    Effect.gen(function* () {
      const opened: Array<string> = []
      const registry = yield* startOrg(Option.some(backendDisabling([], opened)))
      yield* registry.load('backend')
      yield* call(registry, 'SetOverallCap', { cap: 1 })
      yield* call(registry, 'CreateObjective', {
        objective: {
          id: '00000000-0000-4000-8000-500000000001',
          projectId: PROJECT_ID,
          title: 'Ship it',
          description: '',
          priority: 'normal',
          assignee: null
        }
      })
      const ada = yield* hireEngineer(registry)
      const ben = yield* hireEngineer(registry)

      yield* createTask(registry, 1, ada)
      yield* createTask(registry, 2, ben)
      yield* settle
      const atCapOne = opened.length
      yield* call(registry, 'SetOverallCap', { cap: 2 })
      yield* settle

      assert.deepStrictEqual([atCapOne, opened.length], [1, 2])
    })
  )

  it.effect('keeps a running task running when its assignment is repeated', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.some(backendDisabling([])))
      yield* registry.load('backend')
      yield* call(registry, 'CreateObjective', {
        objective: {
          id: '00000000-0000-4000-8000-500000000001',
          projectId: PROJECT_ID,
          title: 'Ship it',
          description: '',
          priority: 'normal',
          assignee: null
        }
      })
      const ada = yield* hireEngineer(registry)
      yield* createTask(registry, 1, ada)
      yield* settle

      yield* call(registry, 'AssignTask', {
        taskId: '00000000-0000-4000-8000-600000000001',
        hireId: ada
      })
      yield* settle
      const work = (yield* call(registry, 'ReadWork', {})) as {
        heldSlots: number
        tasks: ReadonlyArray<{ state: string }>
      }

      assert.deepStrictEqual([work.heldSlots, work.tasks[0]?.state], [1, 'running'])
    })
  )

  it.effect(
    'pushes the work view when subscribed, after a task is created and after it starts',
    () =>
      Effect.gen(function* () {
        const registry = yield* startOrg(Option.some(backendDisabling([])))
        yield* registry.load('backend')
        yield* call(registry, 'CreateObjective', {
          objective: {
            id: '00000000-0000-4000-8000-500000000001',
            projectId: PROJECT_ID,
            title: 'Ship it',
            description: '',
            priority: 'normal',
            assignee: null
          }
        })
        const ada = yield* hireEngineer(registry)
        const views: Array<WorkView> = []
        const stream = yield* subscribePlugin(registry, {
          plugin: 'org',
          tag: 'WatchWork',
          payload: {}
        })
        yield* stream.pipe(
          Stream.runForEach((value) =>
            Effect.sync(() => views.push(Schema.decodeUnknownSync(WorkView)(value)))
          ),
          Effect.forkScoped
        )
        yield* settle
        const onSubscribe = views.map((view) => view.tasks.length)

        yield* createTask(registry, 1, ada)
        yield* settle

        assert.deepStrictEqual(
          {
            onSubscribe,
            last: views.at(-1)?.tasks.map((task) => task.state),
            held: views.at(-1)?.heldSlots
          },
          { onSubscribe: [0], last: ['running'], held: 1 }
        )
      }).pipe(Effect.scoped)
  )
})

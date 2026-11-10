import type { HostPluginContext } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Option, Schema, Stream } from 'effect'
import { callPlugin, servePluginCall } from '../../src/host/plugins/plugin-messages'
import { makePluginDatabase } from '../../src/host/services/database'
import { IssuesView } from './calls'
import setup from './host'
import { PROJECT, registerFixed, UNREGISTERED } from './issues.fake'
import { IssuesKey } from './service'

const OBJECTIVE_ID = '00000000-0000-4000-8000-500000000001'

const manifest = (name: string): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const listingAda = ((ctx: HostPluginContext) =>
  ctx.whenProvided([IssuesKey], ({ issues }) =>
    registerFixed(issues, ['ada']).pipe(Effect.asVoid, Effect.orDie)
  )) as never

const startIssues = (setups: Record<string, never>) =>
  Effect.gen(function* () {
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
            projects: [{ project: { projectId: PROJECT }, tabs: [] }],
            visibleTab: null
          }),
          serve
        } as unknown as HostPluginContext)
      }
    })
    for (const name of Object.keys(setups)) yield* registry.load(name)
    return registry
  })

const call = (registry: PluginRegistry, tag: string, payload: unknown) =>
  callPlugin(registry, { plugin: 'issues', tag, payload })

const readView = (registry: PluginRegistry) =>
  Effect.map(call(registry, 'ReadIssues', {}), (value) =>
    Schema.decodeUnknownSync(IssuesView)(value)
  )

const createObjective = (registry: PluginRegistry, projectId: string) =>
  call(registry, 'CreateObjective', {
    objective: {
      id: OBJECTIVE_ID,
      projectId,
      title: 'Ship it',
      description: '',
      priority: 'normal',
      assignee: null
    }
  })

describe('issues host entry', () => {
  it.effect(
    'loads with no assignee provider and creates an objective in a registered project',
    () =>
      Effect.gen(function* () {
        const registry = yield* startIssues({ issues: setup as never })

        yield* createObjective(registry, PROJECT)

        const view = yield* readView(registry)
        assert.deepStrictEqual(
          [view.objectives.map((objective) => objective.id), view.providers],
          [[OBJECTIVE_ID], []]
        )
      }).pipe(Effect.scoped)
  )

  it.effect('refuses an objective in a project the workspace does not register', () =>
    Effect.gen(function* () {
      const registry = yield* startIssues({ issues: setup as never })

      const exit = yield* Effect.exit(createObjective(registry, UNREGISTERED))

      assert.deepStrictEqual([exit._tag, (yield* readView(registry)).objectives], ['Failure', []])
    }).pipe(Effect.scoped)
  )

  it.effect("lists a provider plugin's assignees until that plugin unloads", () =>
    Effect.gen(function* () {
      const registry = yield* startIssues({ issues: setup as never, provider: listingAda })
      const whileLoaded = (yield* readView(registry)).providers.map((group) =>
        group.assignees.map((assignee) => assignee.id)
      )

      yield* registry.unload('provider')

      assert.deepStrictEqual([whileLoaded, (yield* readView(registry)).providers], [[['ada']], []])
    }).pipe(Effect.scoped)
  )
})

import { type AgentBackend, AgentBackendKey, type HostPluginContext } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { type FeatureManifest, PLUGIN_API_VERSION } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Option, Schema } from 'effect'
import { callPlugin, servePluginCall } from '../../src/host/plugins/plugin-messages'
import { makePluginDatabase } from '../../src/host/services/database'
import { BUILT_IN_ROLES, DEFAULT_OVERALL_CAP, FIRST_RETRO_HIRE_ID } from './built-in-roles'
import { OrgSnapshot } from './calls'
import setup from './host'

const UNKNOWN_HIRE = '00000000-0000-4000-8000-000000000000'

const manifest = (name: string): FeatureManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const backendDisabling = (modes: ReadonlyArray<string>) =>
  ({
    openSession: () => Effect.die('not called'),
    readHistory: () => Effect.die('not called'),
    transcriptInfo: () => Effect.die('not called'),
    readTranscriptAfter: () => Effect.die('not called'),
    models: () => Effect.die('not called'),
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
          serve
        } as unknown as HostPluginContext)
      },
      adapterContract: { keys: [], problems: () => [] }
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
  it.effect('reads the seeded org: every built-in role, the first retro and the default cap', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.none())

      const snapshot = yield* readOrg(registry)

      assert.deepStrictEqual(
        {
          roles: snapshot.roles.map((role) => role.id),
          hires: snapshot.hiredAgents.map((hire) => hire.id),
          cap: snapshot.settings.overallCap
        },
        {
          roles: BUILT_IN_ROLES.map((role) => role.id),
          hires: [FIRST_RETRO_HIRE_ID],
          cap: DEFAULT_OVERALL_CAP
        }
      )
    })
  )

  it.effect('applies a change sent as a call, so the next read shows it', () =>
    Effect.gen(function* () {
      const registry = yield* startOrg(Option.none())

      yield* call(registry, 'RenameHire', { hireId: FIRST_RETRO_HIRE_ID, name: 'calm-heron' })
      yield* call(registry, 'SetBypassOverride', { hireId: FIRST_RETRO_HIRE_ID, override: false })
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

import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Duration, Effect, FileSystem, Option, Path, Schema, Stream } from 'effect'
import { servePluginCall, subscribePlugin } from '../../src/host/plugins/plugin-messages'
import { claudeCodeSources } from '../dia-claude-code/skills'
import metaSetup from '../dia-meta/host'
import setup from './host'
import { Skill, SkillSourceRegistryKey } from './registry'

const manifest = (name: string): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const userSkillsOf =
  (home: string): PluginSetup<HostPluginContext> =>
  (ctx) =>
    Effect.gen(function* () {
      for (const source of yield* claudeCodeSources(home)) {
        yield* ctx.whenProvided([SkillSourceRegistryKey], ({ skillSourceRegistry }) =>
          skillSourceRegistry.register(source)
        )
      }
    }).pipe(Effect.provide(NodeServices.layer))

const startHost = (root: string, home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const setups: Record<string, PluginSetup<HostPluginContext>> = {
      skills: setup,
      meta: metaSetup,
      'claude-code': userSkillsOf(home)
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
          dataDir: path.join(root, 'data', services.name),
          serve
        } as unknown as HostPluginContext)
      }
    })
    for (const name of Object.keys(setups)) yield* registry.load(name)
    return registry
  })

const decodeSkills = Schema.decodeUnknownSync(Schema.Array(Skill))

const skillsWhere = (registry: PluginRegistry, done: (skills: ReadonlyArray<Skill>) => boolean) =>
  Effect.gen(function* () {
    const stream = yield* subscribePlugin(registry, {
      plugin: 'skills',
      tag: 'WatchSkills',
      payload: {}
    })
    const found = yield* stream.pipe(
      Stream.map((value) => decodeSkills(value)),
      Stream.filter(done),
      Stream.runHead,
      Effect.timeout(Duration.seconds(10))
    )
    return Option.getOrThrow(found)
  })

const hasGroup = (group: string) => (skills: ReadonlyArray<Skill>) =>
  skills.some((skill) => skill.group === group)

const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-skills-host-' })
  const writeSkill = (directory: string, entry: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.join(directory, entry), { recursive: true })
      yield* fs.writeFileString(path.join(directory, entry, 'SKILL.md'), '---\n---\n')
    })
  const home = path.join(root, 'home')
  const metaSkills = path.join(root, 'data', 'meta', 'repo', 'plugin', 'skills')
  yield* writeSkill(path.join(home, '.claude', 'skills'), 'review')
  return { root, home, metaSkills, writeSkill }
})

const META_BUILT_IN = { name: 'dia-meta:building-dia-plugins', group: 'Meta repo' }
const META_PLAN = { name: 'dia-meta:plan', group: 'Meta repo' }
const USER_REVIEW = { name: 'review', group: 'Your skills' }

const namesAndGroups = (skills: ReadonlyArray<{ readonly name: string; readonly group: string }>) =>
  skills.map(({ name, group }) => ({ name, group }))

describe('skills host entry', () => {
  it.live('lists a meta repo skill under "Meta repo" and a user skill under "Your skills"', () =>
    Effect.gen(function* () {
      const { root, home, metaSkills, writeSkill } = yield* scratch
      const registry = yield* startHost(root, home)

      yield* writeSkill(metaSkills, 'plan')

      const skills = yield* skillsWhere(registry, (list) => list.length === 3)
      assert.deepStrictEqual(namesAndGroups(skills), [META_BUILT_IN, META_PLAN, USER_REVIEW])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live('drops the meta repo skills when meta unloads', () =>
    Effect.gen(function* () {
      const { root, home, metaSkills, writeSkill } = yield* scratch
      const registry = yield* startHost(root, home)
      yield* writeSkill(metaSkills, 'plan')
      yield* skillsWhere(registry, hasGroup('Meta repo'))

      yield* registry.unload('meta')

      assert.deepStrictEqual(
        namesAndGroups(yield* skillsWhere(registry, (list) => !hasGroup('Meta repo')(list))),
        [USER_REVIEW]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live('lists the meta repo skills again after meta reloads', () =>
    Effect.gen(function* () {
      const { root, home, metaSkills, writeSkill } = yield* scratch
      const registry = yield* startHost(root, home)
      yield* writeSkill(metaSkills, 'plan')
      yield* skillsWhere(registry, (list) => list.length === 3)
      yield* registry.unload('meta')
      yield* skillsWhere(registry, (list) => !hasGroup('Meta repo')(list))

      yield* registry.load('meta')

      assert.deepStrictEqual(
        namesAndGroups(yield* skillsWhere(registry, (list) => list.length === 3)),
        [META_BUILT_IN, META_PLAN, USER_REVIEW]
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

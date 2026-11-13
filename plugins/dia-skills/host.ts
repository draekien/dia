import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { Effect, Option } from 'effect'
import { WatchSkills } from './calls'
import { makeRegistry } from './make-registry'
import { SkillSourceRegistryKey } from './registry'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry
    yield* ctx.provide(SkillSourceRegistryKey, registry)
    yield* ctx.serve(WatchSkills, ({ cwd }) => registry.skills({ cwd: Option.fromNullishOr(cwd) }))
    yield* Effect.logInfo('Skill source registry provided', { plugin: ctx.name })
  })

export default setup

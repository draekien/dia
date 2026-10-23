import { Effect, Predicate } from 'effect'
import type { PluginServices, PluginSetup } from './api'
import { PluginLoadError } from './plugin-registry'

/**
 * Takes the setup function from an imported plugin entry module: its default export. Fails with
 * a {@link PluginLoadError} naming `entry` when the module has no function as its default export.
 */
export const setupFromModule = <Context extends PluginServices>(
  module: unknown,
  entry: string
): Effect.Effect<PluginSetup<Context>, PluginLoadError> => {
  const setup = Predicate.hasProperty(module, 'default') ? module.default : undefined
  return Predicate.isFunction(setup)
    ? Effect.succeed(setup as PluginSetup<Context>)
    : Effect.fail(
        new PluginLoadError({
          message: `"${entry}" must export a setup function as its default export`
        })
      )
}

import { Effect, Predicate } from 'effect'
import type { PluginServices, PluginSetup } from './api'
import { errorMessage, PluginLoadError } from './plugin-registry'

/**
 * Runs `load`, which imports the plugin entry module at `entry`, and takes the setup function
 * from the module's default export. Fails with a {@link PluginLoadError} naming `entry` when the
 * import rejects or the module has no function as its default export.
 */
export const importSetup = <Context extends PluginServices>(
  entry: string,
  load: () => Promise<unknown>
): Effect.Effect<PluginSetup<Context>, PluginLoadError> =>
  Effect.tryPromise({
    try: load,
    catch: (cause) =>
      new PluginLoadError({ message: `Cannot import "${entry}": ${errorMessage(cause)}` })
  }).pipe(
    Effect.flatMap((module) => {
      const setup = Predicate.hasProperty(module, 'default') ? module.default : undefined
      return Predicate.isFunction(setup)
        ? Effect.succeed(setup as PluginSetup<Context>)
        : Effect.fail(
            new PluginLoadError({
              message: `"${entry}" must export a setup function as its default export`
            })
          )
    })
  )

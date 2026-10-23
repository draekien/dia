import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Scope } from 'effect'
import { makeRendererPlugins, type RendererPluginSources } from './renderer-plugins'

const nameOf = (path: string): string => path.split('/').at(-2) ?? path

const byPluginName = <A>(modules: Record<string, A>): Record<string, A> =>
  Object.fromEntries(Object.entries(modules).map(([path, value]) => [nameOf(path), value]))

const builtIn: RendererPluginSources = {
  manifests: byPluginName(
    import.meta.glob<unknown>('../../../../plugins/*/plugin.json', {
      eager: true,
      import: 'default'
    })
  ),
  entries: byPluginName(import.meta.glob('../../../../plugins/*/renderer.ts'))
}

/**
 * Starts the renderer's plugin registry over the plugins bundled with dia and loads every one of
 * them. Call it once when the renderer starts; the returned registry lives for the lifetime of
 * the page, and its `load`, `unload` and `list` operate on the bundled plugins' renderer entries.
 */
export const startRendererPlugins = (): Promise<PluginRegistry> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const registry = yield* makeRendererPlugins(builtIn).pipe(Scope.provide(scope))
      yield* registry.loadAll()
      return registry
    })
  )

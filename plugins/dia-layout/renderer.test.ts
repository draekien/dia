// @vitest-environment jsdom
import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { PagesSlot } from '@dia-plugin/dia-layout/slots'
import { PLUGIN_API_VERSION, type PluginManifest } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Option, Scope } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPage } from '../../src/renderer/src/lib/actions'
import { appRegistry, openPageAtom } from '../../src/renderer/src/lib/workspace-atoms'
import layout from './renderer'

const PANE_A = '00000000-0000-4000-8000-00000000000a'
const GREETING = { plugin: 'example', id: 'greeting' }

const manifest = (name: string): PluginManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  renderer: 'renderer.ts',
  load: 'eager'
})

const addsPage =
  (id: string): PluginSetup<PluginServices> =>
  (ctx) =>
    addEntry(ctx, PagesSlot, {
      id,
      order: 10,
      label: id,
      icon: () => null,
      component: () => null
    })

const startRegistry = (setups: Record<string, PluginSetup<PluginServices>>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const registry: PluginRegistry = yield* makePluginRegistry<PluginServices>({
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
        extend: (services) => Effect.succeed(services)
      }).pipe(Scope.provide(scope))
      yield* registry.start()
      return registry
    })
  )

const openGreetingOverPaneA = () => {
  const selectTab = vi.fn()
  vi.stubGlobal('window', { dia: { selectTab } })
  appRegistry.set(openPageAtom, Option.some({ key: GREETING, shownBefore: PANE_A }))
  openPage(GREETING)
  return selectTab
}

afterEach(() => {
  appRegistry.reset()
  vi.unstubAllGlobals()
})

describe('the layout plugin', () => {
  it('closes the open page when the plugin that added it unloads, and shows the tab it hid', async () => {
    const registry = await startRegistry({ layout, example: addsPage('greeting') })
    const selectTab = openGreetingOverPaneA()

    await Effect.runPromise(registry.unload('example'))

    expect(appRegistry.get(openPageAtom)).toEqual(Option.none())
    expect(selectTab).toHaveBeenLastCalledWith(PANE_A)
  })

  it('leaves the open page open when another plugin removes its page', async () => {
    const registry = await startRegistry({
      layout,
      example: addsPage('greeting'),
      org: addsPage('roster')
    })
    openGreetingOverPaneA()

    await Effect.runPromise(registry.unload('org'))

    expect(Option.map(appRegistry.get(openPageAtom), (open) => open.key)).toEqual(
      Option.some(GREETING)
    )
  })
})

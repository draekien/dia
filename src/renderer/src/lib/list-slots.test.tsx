// @vitest-environment jsdom
import type { PluginServices, PluginSetup } from '@shared/plugin/api'
import { ListSlot } from '@shared/plugin/list-slot'
import { type FeatureManifest, PLUGIN_API_VERSION } from '@shared/plugin/manifest'
import { makePluginRegistry, type PluginRegistry } from '@shared/plugin/plugin-registry'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Duration, Effect, Exit, Option, Scope } from 'effect'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { addEntry, declareList, useList } from './list-slots'
import { setPluginRegistry } from './slots'

interface Card {
  readonly id: string
  readonly order: number
  readonly title: string
}

const CardsSlot = ListSlot.make<Card>('owner.cards')

const OWNER = 'owner'
const CONTRIBUTOR = 'contributor'

const manifest = (name: string): FeatureManifest => ({
  name,
  api: PLUGIN_API_VERSION,
  category: 'feature',
  host: 'host.ts'
})

const startRegistry = async (
  setups: Record<string, PluginSetup<PluginServices>>
): Promise<PluginRegistry> => {
  const scope = Effect.runSync(Scope.make())
  const registry = await Effect.runPromise(
    makePluginRegistry<PluginServices>({
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
      extend: (services) => Effect.succeed(services),
      adapterContract: { keys: [], problems: () => [] }
    }).pipe(Scope.provide(scope))
  )
  setPluginRegistry(registry)
  await act(() => Effect.runPromise(registry.start()))
  return registry
}

const Cards = () => (
  <p data-testid="cards">
    {useList(CardsSlot)
      .map((card) => `${card.key.plugin}:${card.key.id}:${card.title}`)
      .join(',')}
  </p>
)

const shown = () => screen.getByTestId('cards').textContent

const settle = () => act(() => Effect.runPromise(Effect.sleep(Duration.millis(1))))

const run = async (effect: Effect.Effect<unknown>) => {
  await act(() => Effect.runPromise(effect))
  await settle()
}

const declares =
  (onRemove?: (id: string) => void): PluginSetup<PluginServices> =>
  (ctx) =>
    declareList(ctx, CardsSlot, {
      onRemove: (entry) => Effect.sync(() => onRemove?.(entry.key.id))
    })

const adds =
  (...cards: ReadonlyArray<Card>): PluginSetup<PluginServices> =>
  (ctx) =>
    Effect.forEach(cards, (card) => addEntry(ctx, CardsSlot, card), { discard: true })

afterEach(cleanup)

describe('list slots', () => {
  it('lists a contributor’s entries by order and removes them when its scope closes', async () => {
    const registry = await startRegistry({
      [OWNER]: declares(),
      [CONTRIBUTOR]: adds(
        { id: 'tasks', order: 20, title: 'Tasks' },
        { id: 'context', order: 10, title: 'Context' }
      )
    })
    render(<Cards />)
    await settle()
    const whileLoaded = shown()

    await run(registry.unload(CONTRIBUTOR))

    expect(whileLoaded).toBe('contributor:context:Context,contributor:tasks:Tasks')
    expect(shown()).toBe('')
  })

  it('orders entries with the same order by plugin name, then by id', async () => {
    await startRegistry({
      [OWNER]: (ctx) =>
        declareList(ctx, CardsSlot).pipe(
          Effect.andThen(addEntry(ctx, CardsSlot, { id: 'a', order: 5, title: 'A' }))
        ),
      [CONTRIBUTOR]: adds({ id: 'y', order: 5, title: 'Y' }, { id: 'x', order: 5, title: 'X' })
    })
    render(<Cards />)
    await settle()

    expect(shown()).toBe('contributor:x:X,contributor:y:Y,owner:a:A')
  })

  it('replaces an entry the same plugin adds again with the same id', async () => {
    await startRegistry({
      [OWNER]: declares(),
      [CONTRIBUTOR]: adds(
        { id: 'context', order: 10, title: 'First' },
        { id: 'context', order: 10, title: 'Second' }
      )
    })
    render(<Cards />)
    await settle()

    expect(shown()).toBe('contributor:context:Second')
  })

  it('keeps the replacing entry when the scope of the entry it replaced closes', async () => {
    const earlier = Effect.runSync(Scope.make())
    await startRegistry({
      [OWNER]: declares(),
      [CONTRIBUTOR]: (ctx) =>
        addEntry(ctx, CardsSlot, { id: 'context', order: 10, title: 'First' }).pipe(
          Scope.provide(earlier),
          Effect.andThen(addEntry(ctx, CardsSlot, { id: 'context', order: 10, title: 'Second' }))
        )
    })
    render(<Cards />)
    await settle()

    await run(Scope.close(earlier, Exit.void))

    expect(shown()).toBe('contributor:context:Second')
  })

  it('shows nothing while the owner is unloaded and the contributor’s entries once it loads again', async () => {
    const registry = await startRegistry({
      [OWNER]: declares(),
      [CONTRIBUTOR]: adds({ id: 'context', order: 10, title: 'Context' })
    })
    render(<Cards />)
    await settle()

    await run(registry.unload(OWNER))
    const whileUnloaded = shown()
    await run(registry.load(OWNER))

    expect(whileUnloaded).toBe('')
    expect(shown()).toBe('contributor:context:Context')
  })

  it('tells the owner about each entry removed when its contributor closes, but not about a replaced one', async () => {
    const removed: Array<string> = []
    const registry = await startRegistry({
      [OWNER]: declares((id) => removed.push(id)),
      [CONTRIBUTOR]: adds(
        { id: 'context', order: 10, title: 'First' },
        { id: 'context', order: 10, title: 'Second' },
        { id: 'tasks', order: 20, title: 'Tasks' }
      )
    })
    const afterReplace = [...removed]

    await run(registry.unload(CONTRIBUTOR))

    expect(afterReplace).toEqual([])
    expect([...removed].sort()).toEqual(['context', 'tasks'])
  })

  it('rejects an entry that lacks a field of the slot’s entry type', () => {
    const add = (ctx: PluginServices) =>
      // @ts-expect-error a Card needs a title
      addEntry(ctx, CardsSlot, { id: 'x', order: 1 })

    expectTypeOf(add).toBeFunction()
  })
})

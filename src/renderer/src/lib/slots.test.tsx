// @vitest-environment jsdom
import type { PluginServices } from '@shared/plugin/api'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Duration, Effect, Exit, Option, PubSub, Scope, Stream } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { fillSlot, MAIN, ROOT, SIDEBAR, Slot, setKernelDefault, setPluginRegistry } from './slots'

const makeFakeRegistry = Effect.gen(function* () {
  const values = new Map<string, unknown>()
  const changed = yield* PubSub.unbounded<string>()
  const registry: PluginRegistry = {
    list: () => Effect.succeed([]),
    start: () => Effect.void,
    load: () => Effect.die(new Error('not used')),
    unload: () => Effect.die(new Error('not used')),
    inject: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
    changes: Stream.fromPubSub(changed)
  }
  const services = (name: string): PluginServices => ({
    name,
    inject: registry.inject,
    provide: (key, value) =>
      Effect.acquireRelease(
        Effect.sync(() => values.set(key, value)).pipe(
          Effect.andThen(PubSub.publish(changed, key))
        ),
        () =>
          Effect.sync(() => values.delete(key)).pipe(Effect.andThen(PubSub.publish(changed, key)))
      )
  })
  return { registry, services }
})

const Sidebar = () => <p>overview sidebar</p>
const Content = () => <p>kernel content</p>

const settle = () => act(() => Effect.runPromise(Effect.sleep(Duration.millis(1))))

afterEach(cleanup)

describe('Slot', () => {
  it('renders the empty fallback while no plugin fills the slot and it has no kernel default', async () => {
    const { registry } = Effect.runSync(makeFakeRegistry)
    setPluginRegistry(registry)

    render(<Slot name={SIDEBAR} empty={<p>no sidebar plugin</p>} />)
    await settle()

    expect(screen.getByText('no sidebar plugin')).toBeTruthy()
  })

  it('renders the kernel default while no plugin fills the slot', async () => {
    const { registry } = Effect.runSync(makeFakeRegistry)
    setPluginRegistry(registry)
    setKernelDefault(MAIN, Content)

    render(<Slot name={MAIN} />)
    await settle()

    expect(screen.getByText('kernel content')).toBeTruthy()
  })

  it('shows a plugin filler once the plugin fills the slot and the fallback once its scope closes', async () => {
    const { registry, services } = Effect.runSync(makeFakeRegistry)
    setPluginRegistry(registry)
    render(<Slot name={ROOT} empty={<p>no layout plugin</p>} />)
    await settle()
    const scope = Effect.runSync(Scope.make())

    await act(() =>
      Effect.runPromise(
        fillSlot(services('agent-overview'), ROOT, Sidebar).pipe(Scope.provide(scope))
      )
    )
    await settle()
    const whileFilled = screen.queryByText('overview sidebar')
    await act(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    await settle()

    expect(whileFilled).toBeTruthy()
    expect(screen.getByText('no layout plugin')).toBeTruthy()
  })
})

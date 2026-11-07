// @vitest-environment jsdom
import type { AnyServiceKey, PluginServices } from '@shared/plugin/api'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { fakeInject } from '@shared/plugin/plugin-registry.fake'
import { nameOf } from '@shared/plugin/service-key'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Duration, Effect, Exit, Option, PubSub, Scope, Stream } from 'effect'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fillSlot,
  MAIN,
  MAIN_HEADER,
  ROOT,
  SIDEBAR,
  Slot,
  setKernelDefault,
  setPluginRegistry
} from './slots'

const makeFakeRegistry = Effect.gen(function* () {
  const values = new Map<string, unknown>()
  const changed = yield* PubSub.unbounded<string>()
  const registry: PluginRegistry = {
    list: () => Effect.succeed([]),
    start: () => Effect.void,
    load: () => Effect.die(new Error('not used')),
    unload: () => Effect.die(new Error('not used')),
    use: () => Effect.die(new Error('use should not be called in these tests')),
    inject: fakeInject((key) => Option.fromNullishOr(values.get(key))),
    changes: Stream.fromPubSub(changed)
  }
  const services = (name: string): PluginServices => ({
    name,
    inject: registry.inject,
    whenProvided: () => Effect.void,
    provide: (key: AnyServiceKey, value: unknown) => {
      const slot = nameOf(key)
      return Effect.acquireRelease(
        Effect.sync(() => values.set(slot, value)).pipe(
          Effect.andThen(PubSub.publish(changed, slot))
        ),
        () =>
          Effect.sync(() => values.delete(slot)).pipe(Effect.andThen(PubSub.publish(changed, slot)))
      )
    }
  })
  return { registry, services }
})

const Sidebar = () => <p>overview sidebar</p>
const Content = () => <p>kernel content</p>
const Broken = (): never => {
  throw new Error('broken sidebar')
}
const Fixed = () => <p>fixed sidebar</p>

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

  describe('when the filling component throws while rendering', () => {
    const fill = async (plugin: string, name: typeof SIDEBAR, component: () => ReactNode) => {
      const { registry, services } = Effect.runSync(makeFakeRegistry)
      setPluginRegistry(registry)
      const scope = Effect.runSync(Scope.make())
      await act(() =>
        Effect.runPromise(fillSlot(services(plugin), name, component).pipe(Scope.provide(scope)))
      )
      return { services, scope }
    }

    it('shows that the plugin failed in the slot and keeps rendering its siblings', async () => {
      await fill('agent-overview', SIDEBAR, Broken)

      render(
        <>
          <Slot name={SIDEBAR} />
          <p>sibling</p>
        </>
      )
      await settle()

      expect([
        screen.getByText('The agent-overview plugin failed to show this').textContent,
        screen.getByText('sibling').textContent
      ]).toEqual(['The agent-overview plugin failed to show this', 'sibling'])
    })

    it('shows nothing in main.header', async () => {
      await fill('layout', MAIN_HEADER, Broken)

      const { container } = render(<Slot name={MAIN_HEADER} />)
      await settle()

      expect(container.innerHTML).toBe('')
    })

    it('renders the slot again once the plugin fills it with a component that does not throw', async () => {
      const { services, scope } = await fill('agent-overview', SIDEBAR, Broken)
      render(<Slot name={SIDEBAR} />)
      await settle()
      await act(() => Effect.runPromise(Scope.close(scope, Exit.void)))
      const reloaded = Effect.runSync(Scope.make())

      await act(() =>
        Effect.runPromise(
          fillSlot(services('agent-overview'), SIDEBAR, Fixed).pipe(Scope.provide(reloaded))
        )
      )
      await settle()

      expect(screen.getByText('fixed sidebar')).toBeTruthy()
    })
  })
})

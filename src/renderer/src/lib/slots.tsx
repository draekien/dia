import type {
  AnyServiceKey,
  PluginServices,
  ServiceKey,
  ServiceKeyTakenError
} from '@shared/plugin/api'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { nameOf } from '@shared/plugin/service-key'
import { Effect, Fiber, Option, type Scope, Stream } from 'effect'
import { type ComponentType, createElement, type ReactNode, useEffect, useState } from 'react'
import { PluginBoundary } from '../components/plugin-boundary'
import { PluginFailed } from '../components/plugin-failed'

/** A region of the window that a renderer plugin can fill. */
export type SlotName = 'root' | 'sidebar' | 'main' | 'main.header' | 'main.tab'

/** The whole window; there is no title bar band. The layout plugin fills it. */
export const ROOT: SlotName = 'root'
/** The sidebar column the layout plugin declares. The agent overview fills it. */
export const SIDEBAR: SlotName = 'sidebar'
/** The content area the layout plugin declares. Shows the visible tab unless a plugin fills it. */
export const MAIN: SlotName = 'main'
/**
 * The card header row beside the sidebar toggle, rendered by the layout plugin for every view.
 * Shows the breadcrumb and window status unless a plugin fills it; a plugin that does owns the
 * window status items.
 */
export const MAIN_HEADER: SlotName = 'main.header'
/**
 * The visible tab inside the kernel's `main` default. The chat plugin fills it; while it is empty,
 * a tab shows that no chat plugin is loaded. Read the visible tab with `useView` and
 * `useWorkspace`.
 */
export const MAIN_TAB: SlotName = 'main.tab'

const slotKey = (name: SlotName): string => `slot:${name}`

type SlotFiller = { readonly plugin: string; readonly component: ComponentType }

const KERNEL = 'kernel'

let pluginRegistry: PluginRegistry | undefined
const kernelDefaults = new Map<SlotName, ComponentType>()

/**
 * Hands the renderer's plugin registry to {@link Slot}. Call once, before the first render, with
 * the registry `startRendererPlugins` resolved.
 */
export const setPluginRegistry = (registry: PluginRegistry): void => {
  pluginRegistry = registry
}

/**
 * Sets the component {@link Slot} renders for `name` while no plugin fills it. Call before the
 * first render.
 */
export const setKernelDefault = (name: SlotName, component: ComponentType): void => {
  kernelDefaults.set(name, component)
}

/**
 * Fills slot `name` with `component` for the lifetime of the plugin's scope. Fails with
 * {@link ServiceKeyTakenError} when another plugin already fills it.
 */
export const fillSlot = (
  ctx: PluginServices,
  name: SlotName,
  component: ComponentType
): Effect.Effect<void, ServiceKeyTakenError, Scope.Scope> =>
  ctx
    .provide(slotKey(name), { plugin: ctx.name, component } satisfies SlotFiller)
    .pipe(Effect.tap(() => Effect.logDebug('Filled a slot', { slot: name, plugin: ctx.name })))

const providedValue = (key: AnyServiceKey): unknown => {
  if (pluginRegistry === undefined) return undefined
  // biome-ignore lint/plugin/noRegistryInject: a renderer reads a provided value again each time `changes` emits its key (ADR-0055)
  return Option.getOrUndefined(Effect.runSync(pluginRegistry.inject(key)))
}

/**
 * The value a plugin provides under `key` now, or `undefined` while none is provided or it fails a
 * `ServiceKey`'s check. Re-renders when a plugin starts or stops providing it. Pass a key that
 * stays the same between renders.
 */
export function useProvided<S>(key: ServiceKey<S>): S | undefined
export function useProvided(key: string): unknown
export function useProvided(key: AnyServiceKey): unknown {
  const [value, setValue] = useState(() => providedValue(key))
  useEffect(() => {
    const registry = pluginRegistry
    if (registry === undefined) return
    const name = nameOf(key)
    const refresh = () => setValue(() => providedValue(key))
    const follower = Effect.runFork(
      registry.changes.pipe(
        Stream.filter((changed) => changed === name),
        Stream.runForEach(() =>
          Effect.logDebug('Provided value changed', { key: name }).pipe(
            Effect.andThen(Effect.sync(refresh))
          )
        )
      )
    )
    refresh()
    return () => {
      Effect.runFork(Fiber.interrupt(follower))
    }
  }, [key])
  return value
}

/**
 * Renders the component a plugin filled slot `name` with, else the kernel default for `name`,
 * else `empty`. Re-renders when a plugin starts or stops filling the slot.
 */
export function Slot({ name, empty }: { readonly name: SlotName; readonly empty?: ReactNode }) {
  const filler = useProvided(slotKey(name)) as SlotFiller | undefined
  const kernelDefault = kernelDefaults.get(name)
  const plugin = filler?.plugin ?? KERNEL
  const component = filler?.component ?? kernelDefault
  if (component === undefined) return empty ?? null
  return (
    <PluginBoundary
      plugin={plugin}
      at={name}
      resetKey={component}
      fallback={
        name === MAIN_HEADER
          ? undefined
          : (error, retry) => <PluginFailed plugin={plugin} error={error} onRetry={retry} />
      }
    >
      {createElement(component)}
    </PluginBoundary>
  )
}

import type {
  PluginServices,
  ServiceKeyReservedError,
  ServiceKeyTakenError
} from '@shared/plugin/api'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Fiber, Option, type Scope, Stream } from 'effect'
import { type ComponentType, createElement, type ReactNode, useEffect, useState } from 'react'

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
): Effect.Effect<void, ServiceKeyTakenError | ServiceKeyReservedError, Scope.Scope> =>
  ctx
    .provide(slotKey(name), component)
    .pipe(Effect.tap(() => Effect.logDebug('Filled a slot', { slot: name, plugin: ctx.name })))

const fillerOf = (name: SlotName): ComponentType | undefined => {
  if (pluginRegistry === undefined) return undefined
  const filler = Effect.runSync(pluginRegistry.inject(slotKey(name)))
  return Option.getOrUndefined(filler) as ComponentType | undefined
}

const useFiller = (name: SlotName): ComponentType | undefined => {
  const [filler, setFiller] = useState(() => fillerOf(name))
  useEffect(() => {
    const registry = pluginRegistry
    if (registry === undefined) return
    const refresh = () => setFiller(() => fillerOf(name))
    const follower = Effect.runFork(
      registry.changes.pipe(
        Stream.filter((key) => key === slotKey(name)),
        Stream.runForEach(() =>
          Effect.logDebug('Slot filler changed', { slot: name }).pipe(
            Effect.andThen(Effect.sync(refresh))
          )
        )
      )
    )
    refresh()
    return () => {
      Effect.runFork(Fiber.interrupt(follower))
    }
  }, [name])
  return filler
}

/**
 * Renders the component a plugin filled slot `name` with, else the kernel default for `name`,
 * else `empty`. Re-renders when a plugin starts or stops filling the slot.
 */
export function Slot({ name, empty }: { readonly name: SlotName; readonly empty?: ReactNode }) {
  const component = useFiller(name) ?? kernelDefaults.get(name)
  if (component === undefined) return empty ?? null
  return createElement(component)
}

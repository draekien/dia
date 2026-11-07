import type {
  PluginServices,
  ServiceKeyTakenError,
  WhenProvidedRefusedError
} from '@shared/plugin/api'
import type {
  ListEntry,
  ListEntryFields,
  ListSlot,
  ListSlotService
} from '@shared/plugin/list-slot'
import { sameEntryKey } from '@shared/plugin/list-slot'
import { Effect, Order, type Scope } from 'effect'
import { useSyncExternalStore } from 'react'
import { useProvided } from './slots'

interface ListInternals<E extends ListEntryFields> {
  readonly name: string
  readonly onRemove: (entry: ListEntry<E>) => Effect.Effect<void>
  readonly listeners: Set<() => void>
  readonly subscribe: (listener: () => void) => () => void
  entries: ReadonlyArray<ListEntry<E>>
}

const EMPTY: ReadonlyArray<never> = []
const internals = new WeakMap<object, unknown>()

const internalsOf = <E extends ListEntryFields>(
  service: ListSlotService<E>
): ListInternals<E> | undefined => internals.get(service) as ListInternals<E> | undefined

const byPosition: Order.Order<ListEntry<ListEntryFields>> = Order.combineAll([
  Order.mapInput(Order.Number, (entry: ListEntry<ListEntryFields>) => entry.order),
  Order.mapInput(Order.String, (entry: ListEntry<ListEntryFields>) => entry.key.plugin),
  Order.mapInput(Order.String, (entry: ListEntry<ListEntryFields>) => entry.key.id)
])

const publish = <E extends ListEntryFields>(
  list: ListInternals<E>,
  entries: ReadonlyArray<ListEntry<E>>
): void => {
  list.entries = entries
  for (const listener of list.listeners) listener()
}

const put = <E extends ListEntryFields>(list: ListInternals<E>, entry: ListEntry<E>) =>
  Effect.gen(function* () {
    const replaces = list.entries.some((existing) => sameEntryKey(existing.key, entry.key))
    publish(
      list,
      [...list.entries.filter((existing) => !sameEntryKey(existing.key, entry.key)), entry].sort(
        byPosition
      )
    )
    yield* Effect.logDebug(replaces ? 'Replaced a list entry' : 'Added a list entry', {
      slot: list.name,
      plugin: entry.key.plugin,
      id: entry.key.id
    })
  })

const release = <E extends ListEntryFields>(list: ListInternals<E>, entry: ListEntry<E>) =>
  Effect.gen(function* () {
    if (!list.entries.includes(entry)) return
    publish(
      list,
      list.entries.filter((existing) => existing !== entry)
    )
    yield* Effect.logDebug('Removed a list entry', {
      slot: list.name,
      plugin: entry.key.plugin,
      id: entry.key.id
    })
    yield* list.onRemove(entry)
  })

const add = <E extends ListEntryFields>(
  service: ListSlotService<E>,
  plugin: string,
  fields: E
): Effect.Effect<void, never, Scope.Scope> => {
  const list = internalsOf(service)
  if (list === undefined) {
    return Effect.logError('A list slot service has no internals', { plugin, id: fields.id })
  }
  const entry: ListEntry<E> = { ...fields, key: { plugin, id: fields.id } }
  return Effect.acquireRelease(put(list, entry), () => release(list, entry))
}

/**
 * Provides list slot `slot` for the lifetime of the plugin's scope; the list starts empty and is
 * discarded when the scope closes. `onRemove` runs after an entry is released while the list is
 * declared: its contributor's scope closed, including when the owner itself closes or reloads,
 * because contributors close before their provider. It does not run when an entry is replaced.
 * Fails with {@link ServiceKeyTakenError} when another plugin declares the same slot.
 */
export const declareList = <E extends ListEntryFields>(
  ctx: PluginServices,
  slot: ListSlot<E>,
  options?: { readonly onRemove?: (entry: ListEntry<E>) => Effect.Effect<void> }
): Effect.Effect<void, ServiceKeyTakenError, Scope.Scope> =>
  Effect.gen(function* () {
    const service: ListSlotService<E> = { _tag: 'ListSlotService' }
    const listeners = new Set<() => void>()
    const list: ListInternals<E> = {
      name: slot.name,
      onRemove: options?.onRemove ?? (() => Effect.void),
      listeners,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      entries: EMPTY
    }
    internals.set(service, list)
    yield* ctx.provide(slot, service)
    yield* Effect.logDebug('Declared a list slot', { slot: slot.name, plugin: ctx.name })
  })

/**
 * Adds `entry` to `slot` while both this plugin's scope and the slot's declaration are open. When
 * the owner closes, the entry is released; when the owner declares the slot again, the entry is
 * added again. Adding the same `id` again from the same plugin replaces the entry. Needs no
 * `inject` in plugin.json.
 */
export const addEntry = <E extends ListEntryFields>(
  ctx: PluginServices,
  slot: ListSlot<E>,
  entry: NoInfer<E>
): Effect.Effect<void, WhenProvidedRefusedError, Scope.Scope> =>
  ctx.whenProvided([slot], (services) => add(services[slot.name], ctx.name, entry))

const noListeners = (): (() => void) => () => {}

/**
 * The entries of `slot`, ordered by `order`, ties by plugin name then `id`; empty while no plugin
 * declares it. Re-renders when an entry is added, replaced or removed, and when the slot is
 * declared or withdrawn. Pass a key that stays the same between renders.
 */
export function useList<E extends ListEntryFields>(slot: ListSlot<E>): ReadonlyArray<ListEntry<E>> {
  const service = useProvided(slot)
  const list = service === undefined ? undefined : internalsOf(service)
  return useSyncExternalStore(list?.subscribe ?? noListeners, () => list?.entries ?? EMPTY)
}

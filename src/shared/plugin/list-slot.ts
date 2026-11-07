import { Predicate } from 'effect'
import { ServiceKey } from './api'

/**
 * The fields every list entry has. `id` is unique among the entries one plugin adds to a list;
 * entries with a lower `order` come first. `key` is reserved for the key the list adds.
 */
export interface ListEntryFields {
  readonly id: string
  readonly order: number
  readonly key?: never
}

/** The plugin that added a list entry and the entry's `id`. */
export interface ListEntryKey {
  readonly plugin: string
  readonly id: string
}

/** Whether `a` and `b` name the same entry: the same adding plugin and the same `id`. */
export const sameEntryKey = (a: ListEntryKey, b: ListEntryKey): boolean =>
  a.plugin === b.plugin && a.id === b.id

/** An entry as a list holds it: the fields its plugin added, plus the {@link ListEntryKey}. */
export type ListEntry<E extends ListEntryFields> = Omit<E, 'key'> & { readonly key: ListEntryKey }

/**
 * The value a list slot's owner provides under the slot's key. It is opaque: declare, add to and
 * read a list only through `declareList`, `addEntry` and `useList` from `@dia/renderer-plugin`.
 */
export interface ListSlotService<E extends ListEntryFields> {
  readonly _tag: 'ListSlotService'
  readonly _entry?: (entry: E) => E
}

/**
 * A typed list slot key (ADR-0061): a `ServiceKey` whose service is a {@link ListSlotService} with
 * entries of type `E`.
 */
export type ListSlot<E extends ListEntryFields> = ServiceKey<ListSlotService<E>>

// biome-ignore lint/suspicious/noExplicitAny: the guard cannot check the entry type, which only the key carries
const isListSlotService = (value: unknown): value is ListSlotService<any> =>
  Predicate.hasProperty(value, '_tag') && value._tag === 'ListSlotService'

/** Constructors for {@link ListSlot}. */
export const ListSlot = {
  /**
   * A list slot key named `name` whose entries have type `E`. Make it in a module the owning plugin
   * exports, and prefix `name` with the owner's plugin name (`layout.pages`), because list slot
   * names share the registry's service names.
   */
  make: <E extends ListEntryFields>(name: string): ListSlot<E> =>
    ServiceKey.make(name, isListSlotService)
}

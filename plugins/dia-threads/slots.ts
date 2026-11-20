import { type ListEntryFields, ListSlot } from '@dia/plugin'

/** One entry another plugin adds to a thread row's right-click menu. */
export interface ThreadRowMenuEntry extends ListEntryFields {
  readonly label: string
  /** Runs when the user picks the entry on the row of thread `paneId`. */
  readonly onSelect: (thread: { readonly paneId: string }) => void
}

/** The entries added to a thread row's right-click menu, declared by dia-threads. Add one with `addEntry(ctx, ThreadRowMenuSlot, entry)`. */
export const ThreadRowMenuSlot = ListSlot.make<ThreadRowMenuEntry>('threads.row-menu')

/**
 * A plugin whose owned tabs the Meta group lists as thread rows. `owner` is the plugin name that
 * `TabOwner.plugin` carries; `newThreadLabel` is the tooltip and accessible name of the header's
 * `+`, which calls `newThread`. dia-creator is the one source today.
 */
export interface MetaThreadSource extends ListEntryFields {
  readonly owner: string
  readonly newThreadLabel: string
  readonly newThread: () => void
}

/** The Meta group's thread sources, declared by dia-threads. Add one with `addEntry(ctx, MetaThreadSourcesSlot, source)`. */
export const MetaThreadSourcesSlot = ListSlot.make<MetaThreadSource>('threads.metaSources')

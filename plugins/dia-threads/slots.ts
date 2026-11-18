import { type ListEntryFields, ListSlot } from '@dia/plugin'

/** One entry another plugin adds to a thread row's right-click menu. */
export interface ThreadRowMenuEntry extends ListEntryFields {
  readonly label: string
  /** Runs when the user picks the entry on the row of thread `paneId`. */
  readonly onSelect: (thread: { readonly paneId: string }) => void
}

/** The entries added to a thread row's right-click menu, declared by dia-threads. Add one with `addEntry(ctx, ThreadRowMenuSlot, entry)`. */
export const ThreadRowMenuSlot = ListSlot.make<ThreadRowMenuEntry>('threads.row-menu')

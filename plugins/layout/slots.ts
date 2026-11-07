import { ListSlot } from '@dia/plugin'
import type { ComponentType } from 'react'

/** A page in the content area, listed in the sidebar. `label` is the sidebar entry's text and the header's breadcrumb; `component` draws the page body. */
export interface Page {
  readonly id: string
  readonly order: number
  readonly label: string
  readonly icon: ComponentType<{ readonly className?: string }>
  readonly component: ComponentType
}

/** The content area's pages, declared by the layout plugin. Add a page with `addEntry(ctx, PagesSlot, page)`. */
export const PagesSlot = ListSlot.make<Page>('layout.pages')

/** A dialog drawn over the window. `component` renders the dialog and decides when it is open, usually from a window event. */
export interface DialogEntry {
  readonly id: string
  readonly order: number
  readonly component: ComponentType
}

/** The window's dialogs, declared by the layout plugin. Add a dialog with `addEntry(ctx, DialogsSlot, dialog)`. */
export const DialogsSlot = ListSlot.make<DialogEntry>('layout.dialogs')

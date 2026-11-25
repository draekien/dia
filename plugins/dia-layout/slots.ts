import { ListSlot } from '@dia/plugin'
import type { Atom } from 'effect/reactivity'
import type { ComponentType } from 'react'

/** A page in the content area, listed in the sidebar. `label` is the sidebar entry's text and the header's breadcrumb; `component` draws the page body and receives the `target` the page was opened with (`actions.openPage`), or undefined. */
export interface Page {
  readonly id: string
  readonly order: number
  readonly label: string
  readonly icon: ComponentType<{ readonly className?: string }>
  readonly component: ComponentType<{ readonly target: string | undefined }>
  /**
   * An atom naming the tab (by pane id) the sidebar entry stands for, or null. While it names a
   * tab, the entry selects that tab and shows its status instead of opening `component`.
   */
  readonly tab?: Atom.Atom<string | null>
}

/** The content area's pages, declared by the layout plugin. Add a page with `addEntry(ctx, PagesSlot, page)`. */
export const PagesSlot = ListSlot.make<Page>('layout.pages')

/** A section of the sidebar, drawn below the pages and above the project groups. */
export interface SidebarSection {
  readonly id: string
  readonly order: number
  /** Draws the section; `iconMode` is true while the sidebar is collapsed to its rail. */
  readonly component: ComponentType<{ readonly iconMode: boolean }>
}

/** The sidebar's sections, declared by the layout plugin. Add one with `addEntry(ctx, SidebarSectionsSlot, section)`. */
export const SidebarSectionsSlot = ListSlot.make<SidebarSection>('layout.sections')

/** A dialog drawn over the window. `component` renders the dialog and decides when it is open, usually from a window event. */
export interface DialogEntry {
  readonly id: string
  readonly order: number
  readonly component: ComponentType
}

/** The window's dialogs, declared by the layout plugin. Add a dialog with `addEntry(ctx, DialogsSlot, dialog)`. */
export const DialogsSlot = ListSlot.make<DialogEntry>('layout.dialogs')

/** An entry in the status bar. `side` picks the left (`start`) or right (`end`) group; `order` sorts within the group, the lowest `order` nearest the group's outer edge. `component` draws the whole entry, including any tooltip or click action. */
export interface StatusBarItem {
  readonly id: string
  readonly order: number
  readonly side: 'start' | 'end'
  readonly component: ComponentType
}

/** The status bar's entries, declared by the layout plugin. Add one with `addEntry(ctx, StatusBarItemsSlot, item)`. */
export const StatusBarItemsSlot = ListSlot.make<StatusBarItem>('layout.statusBar')

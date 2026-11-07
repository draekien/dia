import { ListSlot } from '@dia/plugin'
import type { ComponentType } from 'react'

/**
 * The settings of one adapter plugin on the Adapters page. `id` is the adapter plugin's name.
 * `label` replaces that name in the adapter's row and the breadcrumb, `statusLine` draws the row's
 * second line, and `component` draws the adapter's settings. `order` is not used: rows follow the
 * plugin list.
 */
export interface AdapterPanel {
  readonly id: string
  readonly order: number
  readonly label: string
  readonly component: ComponentType
  readonly statusLine: ComponentType
}

/** The adapter panels of the Adapters page, declared by the adapters plugin. Add one with `addEntry(ctx, AdapterPanelsSlot, panel)`. */
export const AdapterPanelsSlot = ListSlot.make<AdapterPanel>('adapters.panels')

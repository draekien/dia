import type { PluginServices } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { PagesSlot } from '@dia-plugin/dia-layout/slots'
import { describe, expectTypeOf, it } from 'vitest'

describe('PagesSlot', () => {
  it('rejects a page without its label, icon and component', () => {
    const add = (ctx: PluginServices) =>
      // @ts-expect-error a Page needs a label, an icon and a component
      addEntry(ctx, PagesSlot, { id: 'x', order: 1 })

    expectTypeOf(add).toBeFunction()
  })
})

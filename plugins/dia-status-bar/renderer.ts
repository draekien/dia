import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { StatusBarItemsSlot } from '@dia-plugin/dia-layout/slots'
import { Effect } from 'effect'
import { UpdateEntry } from './update-entry'
import { VersionEntry } from './version-entry'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* addEntry(ctx, StatusBarItemsSlot, {
      id: 'update',
      order: 10,
      side: 'start',
      component: UpdateEntry
    })
    yield* addEntry(ctx, StatusBarItemsSlot, {
      id: 'version',
      order: 20,
      side: 'start',
      component: VersionEntry
    })
    yield* Effect.logInfo('Version and update status bar entries added', { plugin: ctx.name })
  })

export default setup

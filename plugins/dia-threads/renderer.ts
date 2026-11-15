import type { PluginServices, PluginSetup } from '@dia/plugin'
import { fillSlot, SIDEBAR } from '@dia/renderer-plugin'
import { ThreadsSidebar } from './threads-sidebar'

const setup: PluginSetup<PluginServices> = (ctx) => fillSlot(ctx, SIDEBAR, ThreadsSidebar)

export default setup

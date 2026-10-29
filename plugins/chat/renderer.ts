import type { PluginServices, PluginSetup } from '@dia/plugin'
import { fillSlot, MAIN_TAB } from '@dia/renderer-plugin'
import { Chat } from './chat'

const setup: PluginSetup<PluginServices> = (ctx) => fillSlot(ctx, MAIN_TAB, Chat)

export default setup

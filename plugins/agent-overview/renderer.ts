import type { PluginServices, PluginSetup } from '@dia/plugin'
import { fillSlot, SIDEBAR } from '@dia/renderer-plugin'
import { AgentOverview } from './agent-overview'

const setup: PluginSetup<PluginServices> = (ctx) => fillSlot(ctx, SIDEBAR, AgentOverview)

export default setup

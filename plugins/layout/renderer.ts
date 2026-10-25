import type { PluginServices, PluginSetup } from '@dia/plugin'
import { fillSlot, ROOT } from '@dia/renderer-plugin'
import { Layout } from './layout'

const setup: PluginSetup<PluginServices> = (ctx) => fillSlot(ctx, ROOT, Layout)

export default setup

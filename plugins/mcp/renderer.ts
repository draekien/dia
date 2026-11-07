import type { PluginServices, PluginSetup } from '@dia/plugin'
import { Effect } from 'effect'
import { McpServersEditorKey } from './editor'
import { McpServersEditor } from './servers-editor'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(McpServersEditorKey, McpServersEditor)
    yield* Effect.logDebug('MCP servers editor provided', { key: McpServersEditorKey.name })
  })

export default setup

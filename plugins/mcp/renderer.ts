import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, openSettings } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/command-palette/slots'
import { SettingsPagesSlot } from '@dia-plugin/settings/slots'
import { Effect } from 'effect'
import { PlugIcon, SettingsIcon } from 'lucide-react'
import { createElement } from 'react'
import { McpServersEditorKey } from './editor'
import { McpServersEditor } from './servers-editor'
import { McpServersSettings, makeServersAtom } from './settings-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(McpServersEditorKey, McpServersEditor)
    yield* Effect.logDebug('MCP servers editor provided', { key: McpServersEditorKey.name })
    const serversAtom = makeServersAtom(ctx)
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'mcp',
      order: 45,
      label: 'MCP servers',
      icon: PlugIcon,
      component: () => createElement(McpServersSettings, { ctx, serversAtom })
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'mcp-settings',
      order: 145,
      group: 'Settings pages',
      label: 'Settings › MCP servers',
      icon: SettingsIcon,
      keywords: ['mcp', 'servers', 'tools', 'model context protocol'],
      searchOnly: true,
      run: () => openSettings({ plugin: 'mcp', id: 'mcp' })
    })
  })

export default setup

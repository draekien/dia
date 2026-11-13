import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, openSettings } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/dia-command-palette/slots'
import { SettingsPagesSlot } from '@dia-plugin/dia-settings/slots'
import { Effect } from 'effect'
import { PlugIcon, SettingsIcon } from 'lucide-react'
import { createElement } from 'react'
import { McpServersEditorKey } from './editor'
import { McpServerPickerKey, type McpServerPickerProps } from './picker'
import { McpServerPicker } from './server-picker'
import { McpServersEditor } from './servers-editor'
import { McpServersSettings, makeServersAtom } from './settings-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const serversAtom = makeServersAtom(ctx)
    yield* ctx.provide(McpServersEditorKey, McpServersEditor)
    yield* Effect.logDebug('MCP servers editor provided', { key: McpServersEditorKey.name })
    yield* ctx.provide(McpServerPickerKey, (props: McpServerPickerProps) =>
      createElement(McpServerPicker, { ...props, serversAtom })
    )
    yield* Effect.logDebug('MCP server picker provided', { key: McpServerPickerKey.name })
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
      run: () => openSettings({ plugin: 'dia-mcp', id: 'mcp' })
    })
  })

export default setup

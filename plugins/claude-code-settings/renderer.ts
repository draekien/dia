import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, CLAUDE_CODE_SETTINGS, openSettings } from '@dia/renderer-plugin'
import { AdapterPanelsSlot } from '@dia-plugin/adapters/slots'
import { CommandsSlot } from '@dia-plugin/command-palette/slots'
import { Effect } from 'effect'
import { SettingsIcon } from 'lucide-react'
import { ClaudeCodeHealthLabel, ClaudeCodeSettings } from './claude-code-settings'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* addEntry(ctx, AdapterPanelsSlot, {
      id: 'claude-code',
      order: 10,
      label: 'Claude Code',
      component: ClaudeCodeSettings,
      statusLine: ClaudeCodeHealthLabel
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'claude-code',
      order: 125,
      group: 'Settings pages',
      label: 'Settings › Adapters › Claude Code',
      icon: SettingsIcon,
      keywords: ['claude', 'models', 'model', 'health', 'install'],
      searchOnly: true,
      run: () => openSettings(CLAUDE_CODE_SETTINGS)
    })
  })

export default setup

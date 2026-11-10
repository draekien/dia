import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { SettingsPagesSlot } from '@dia-plugin/settings/slots'
import { Effect } from 'effect'
import { GitBranchIcon } from 'lucide-react'
import { createElement } from 'react'
import { makeWorktreesAtom, WorktreesSettings } from './settings-page'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const worktreesAtom = makeWorktreesAtom(ctx)
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'worktrees',
      order: 46,
      label: 'Worktrees',
      icon: GitBranchIcon,
      component: () => createElement(WorktreesSettings, { ctx, worktreesAtom })
    })
  })

export default setup

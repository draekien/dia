import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, callHost } from '@dia/renderer-plugin'
import { SettingsPagesSlot } from '@dia-plugin/dia-settings/slots'
import { ThreadRowMenuSlot } from '@dia-plugin/dia-threads/slots'
import { Effect } from 'effect'
import { TypeIcon } from 'lucide-react'
import { createElement } from 'react'
import { RegenerateTitle } from './calls'
import {
  makeTextGenerationSettingsAtom,
  TextGenerationSettingsPage
} from './text-generation-settings'

const regenerate = (paneId: string) =>
  Effect.runFork(
    callHost('dia-text-generation', RegenerateTitle, { paneId }).pipe(
      Effect.tap(() => Effect.logInfo('Regenerated a thread title', { paneId })),
      Effect.catch((error) =>
        Effect.logWarning('Could not regenerate a thread title', { paneId, reason: error._tag })
      )
    )
  )

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const settingsAtom = makeTextGenerationSettingsAtom(ctx)
    yield* addEntry(ctx, SettingsPagesSlot, {
      id: 'text-generation',
      order: 25,
      label: 'Text generation',
      icon: TypeIcon,
      component: () => createElement(TextGenerationSettingsPage, { settingsAtom })
    })
    yield* addEntry(ctx, ThreadRowMenuSlot, {
      id: 'regenerate-title',
      order: 10,
      label: 'Regenerate title',
      onSelect: ({ paneId }) => regenerate(paneId)
    })
  })

export default setup

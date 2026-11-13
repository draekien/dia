// @vitest-environment jsdom
import type { PluginServices, PluginSetup } from '@dia/plugin'
import { declareList, useList } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/dia-command-palette/slots'
import { PagesSlot } from '@dia-plugin/dia-layout/slots'
import { SettingsPagesSlot } from '@dia-plugin/dia-settings/slots'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import org from './renderer'

const declaresSlots: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* declareList(ctx, PagesSlot)
    yield* declareList(ctx, SettingsPagesSlot)
    yield* declareList(ctx, CommandsSlot)
  })

function Keys() {
  const keys = [
    ...useList(PagesSlot).map((entry) => `page ${entry.key.plugin}/${entry.key.id}`),
    ...useList(SettingsPagesSlot).map((entry) => `settings ${entry.key.plugin}/${entry.key.id}`),
    ...useList(CommandsSlot).map((entry) => `command ${entry.key.plugin}/${entry.key.id}`)
  ]
  return <p data-testid="keys">{keys.join(', ')}</p>
}

afterEach(cleanup)

describe('org renderer entry', () => {
  it('adds the Org page, the Org Settings page and its command until the plugin unloads', async () => {
    const registry = await startRendererRegistry({ slots: declaresSlots, org })
    render(<Keys />)
    const whileLoaded = screen.getByTestId('keys').textContent

    await act(() => Effect.runPromise(registry.unload('org')))

    expect([whileLoaded, screen.getByTestId('keys').textContent]).toEqual([
      'page org/org, settings org/org, command org/org-settings',
      ''
    ])
  })
})

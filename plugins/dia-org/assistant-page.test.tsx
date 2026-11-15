// @vitest-environment jsdom
import { followHost } from '@dia/renderer-plugin'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Atom } from 'effect/reactivity'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import { AssistantPage } from './assistant-page'
import { WatchOrgLive } from './calls'
import { ASSISTANT_RUN, type FakeHost, installHost, type Reply, snapshotOf } from './org-host.fake'

const ctx = { name: 'org' }

beforeEach(async () => {
  await startRendererRegistry({})
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

const show = async (host: FakeHost) => {
  render(<AssistantPage ctx={ctx} liveAtom={Atom.make(followHost(ctx, WatchOrgLive, {}))} />)
  await act(async () => {})
  return host
}

const tags = (host: FakeHost) => host.sent.map(([tag]) => tag)

describe('AssistantPage', () => {
  it("opens the assistant's run and shows it in its tab", async () => {
    const host = await show(installHost(snapshotOf()))

    await waitFor(() =>
      expect(host.sent).toEqual([
        ['OpenAssistant', {}],
        ['OpenRunInTab', { runId: ASSISTANT_RUN }]
      ])
    )
  })

  it('says the job title is disabled and opens nothing', async () => {
    const host = await show(
      installHost(
        snapshotOf(),
        {},
        { assistantEnabled: false, assistantRunId: null, teamHasWork: false }
      )
    )

    expect(
      screen.getByText('The Executive assistant job title is disabled, so it cannot take requests.')
    ).toBeTruthy()
    expect(host.sent).toEqual([])
  })

  it('offers Try again when the run cannot be opened, and opens it on retry', async () => {
    let failing = true
    const openReply = (): Reply =>
      failing ? { notServing: 'not ready' } : { value: ASSISTANT_RUN }
    const host = await show(installHost(snapshotOf(), { OpenAssistant: openReply }))
    const retry = await screen.findByRole('button', { name: 'Try again' })
    failing = false

    fireEvent.click(retry)

    await waitFor(() =>
      expect(tags(host)).toEqual(['OpenAssistant', 'OpenAssistant', 'OpenRunInTab'])
    )
  })
})

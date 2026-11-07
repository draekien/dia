// @vitest-environment jsdom
import { callHost } from '@dia/renderer-plugin'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Atom } from 'effect/reactivity'
import { afterEach, describe, expect, it } from 'vitest'
import { ReadOrg } from './calls'
import { type FakeHost, installHost, snapshotOf } from './org-host.fake'
import { OrgSettingsPage } from './org-settings-page'

const ctx = { name: 'org' }
const LABEL = 'Hired agents running at once'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

const renderPage = async (): Promise<FakeHost> => {
  const host = installHost(snapshotOf())
  render(<OrgSettingsPage ctx={ctx} orgAtom={Atom.make(callHost(ctx, ReadOrg, {}))} />)
  await screen.findByLabelText(LABEL)
  return host
}

const enter = (value: string) =>
  fireEvent.change(screen.getByLabelText(LABEL), { target: { value } })

describe('Org settings page', () => {
  it.each(['0', '1.5', ''])('shows the error and sends nothing for %j', async (value) => {
    const host = await renderPage()

    enter(value)
    await act(async () => {
      fireEvent.blur(screen.getByLabelText(LABEL))
    })

    expect([host.sent, screen.getByText('Enter a whole number of 1 or more')]).toEqual([
      [],
      expect.anything()
    ])
  })

  it('saves the cap on blur', async () => {
    const host = await renderPage()

    enter('6')
    await act(async () => {
      fireEvent.blur(screen.getByLabelText(LABEL))
    })

    expect(host.sent).toEqual([['SetOverallCap', { cap: 6 }]])
  })

  it('saves the cap on Enter', async () => {
    const host = await renderPage()

    enter('6')
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText(LABEL), { key: 'Enter' })
    })

    expect(host.sent).toEqual([['SetOverallCap', { cap: 6 }]])
  })

  it('sends one call when Enter is followed by blur', async () => {
    const host = await renderPage()

    enter('6')
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText(LABEL), { key: 'Enter' })
      fireEvent.blur(screen.getByLabelText(LABEL))
    })

    expect(host.sent).toEqual([['SetOverallCap', { cap: 6 }]])
  })

  it('sends nothing when the cap is unchanged', async () => {
    const host = await renderPage()

    await act(async () => {
      fireEvent.blur(screen.getByLabelText(LABEL))
    })

    expect(host.sent).toEqual([])
  })
})

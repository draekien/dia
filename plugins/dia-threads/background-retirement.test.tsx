// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the test holds an archive or delete call open with a manually resolved Promise.

import { Toaster } from '@dia/renderer-plugin'
import type { PaneId } from '@shared/domain/pane'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retireInBackground, useRetirement } from './background-retirement'

const PANE = '00000000-0000-4000-8000-000000000201' as PaneId
const TARGET = { paneId: PANE, name: 'brave-otter' }
const LOST_CONNECTION = "The connection to dia's background process was lost."

interface Pending {
  readonly resolve: (reason: string | null) => void
  readonly reject: () => void
}

const installBridge = () => {
  const pending: Array<Pending> = []
  const call = vi.fn(
    () =>
      new Promise<string | null>((resolve, reject) => {
        pending.push({ resolve, reject: () => reject(new Error('lost')) })
      })
  )
  Object.assign(window, { dia: { archiveTab: call, deleteTab: call } })
  const settle = async (outcome: string | null | 'reject') => {
    const next = pending.shift()
    if (next === undefined) throw new Error('no pending call')
    await act(async () => {
      if (outcome === 'reject') next.reject()
      else next.resolve(outcome)
    })
  }
  return { call, settle }
}

function Probe() {
  return <output aria-label="retirement">{useRetirement(PANE) ?? 'none'}</output>
}

const renderProbe = () =>
  render(
    <Toaster>
      <Probe />
    </Toaster>
  )

const retirementShown = () => screen.getByLabelText('retirement').textContent
const toastTitles = () =>
  [...document.querySelectorAll('[data-slot="toast-title"]')].map((title) => title.textContent)

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('retireInBackground', () => {
  it('reports the retirement as running until the host finishes it', async () => {
    const bridge = installBridge()
    renderProbe()

    act(() => retireInBackground(TARGET, 'archive'))
    const whileRunning = retirementShown()
    await bridge.settle(null)

    expect([whileRunning, retirementShown(), toastTitles()]).toEqual(['archive', 'none', []])
  })

  it('archives through archiveTab and deletes through deleteTab with the target pane', async () => {
    const archiveTab = vi.fn(async () => null)
    const deleteTab = vi.fn(async () => null)
    Object.assign(window, { dia: { archiveTab, deleteTab } })

    await act(async () => retireInBackground(TARGET, 'delete'))

    expect([archiveTab.mock.calls, deleteTab.mock.calls]).toEqual([[], [[PANE]]])
  })

  it('ignores a second retirement of a pane that is already being retired', async () => {
    const bridge = installBridge()
    renderProbe()

    act(() => retireInBackground(TARGET, 'archive'))
    act(() => retireInBackground(TARGET, 'delete'))
    const calls = bridge.call.mock.calls.length
    await bridge.settle(null)

    expect(calls).toBe(1)
  })

  it('shows the host reason in an error toast and ends the retirement', async () => {
    const bridge = installBridge()
    renderProbe()

    act(() => retireInBackground(TARGET, 'archive'))
    await bridge.settle('The worktree directory is still on disk')

    await screen.findByText('Could not archive brave-otter')
    expect([
      screen.queryByText('The worktree directory is still on disk') !== null,
      screen.queryByRole('button', { name: 'Try again' }) !== null,
      retirementShown()
    ]).toEqual([true, true, 'none'])
  })

  it('names the lost connection when the call is rejected', async () => {
    const bridge = installBridge()
    renderProbe()

    act(() => retireInBackground(TARGET, 'delete'))
    await bridge.settle('reject')

    await screen.findByText('Could not delete brave-otter')
    expect(screen.queryByText(LOST_CONNECTION)).not.toBeNull()
  })

  it('starts the same retirement again from Try again and leaves one toast for the thread', async () => {
    const bridge = installBridge()
    renderProbe()
    act(() => retireInBackground(TARGET, 'archive'))
    await bridge.settle('Locked')
    await screen.findByRole('button', { name: 'Try again' })

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    const whileRetrying = retirementShown()
    await bridge.settle('Still locked')

    await screen.findByText('Still locked')
    await waitFor(() => expect(screen.queryByText('Locked')).toBeNull())
    expect([bridge.call.mock.calls.length, whileRetrying, toastTitles()]).toEqual([
      2,
      'archive',
      ['Could not archive brave-otter']
    ])
  })
})

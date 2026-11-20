// @vitest-environment jsdom
import { TooltipProvider } from '@dia/renderer-plugin'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnChange } from './calls'
import { TurnChangeView, type TurnChangeViewProps } from './turn-change-line'

const COMMIT = { sha: 'a1b2c3d4e5f60718', subject: 'feat: add weather plugin' }

const turn = (overrides: Partial<TurnChange> = {}): TurnChange => ({
  turnId: 'm1',
  messageIds: ['m1'],
  ended: true,
  commits: [COMMIT],
  loads: [],
  revert: null,
  ...overrides
})

const show = (props: Partial<TurnChangeViewProps> & { readonly change: TurnChange }) =>
  render(
    <TooltipProvider>
      <TurnChangeView
        merge={undefined}
        onRevert={() => Promise.resolve(null)}
        onMerge={() => Promise.resolve(null)}
        {...props}
      />
    </TooltipProvider>
  )

afterEach(cleanup)

describe('TurnChangeView', () => {
  it('names the loaded plugin and the commit with Revert, which reverts the turn', () => {
    const onRevert = vi.fn(() => Promise.resolve(null))
    show({ change: turn({ loads: [{ plugin: 'weather', loaded: true }] }), onRevert })

    expect(screen.getByText('Loaded weather')).toBeTruthy()
    expect(screen.getByText('a1b2c3d')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))

    expect(onRevert).toHaveBeenCalledOnce()
  })

  it('offers no Revert while the turn is still running', () => {
    show({ change: turn({ ended: false }) })

    expect(screen.queryByRole('button', { name: 'Revert' })).toBeNull()
  })

  it('shows the revert commit once the turn is reverted', () => {
    show({ change: turn({ revert: { sha: 'e4f5a6b7c8d9' } }) })

    expect(screen.getByText(/a1b2c3d reverted in/).textContent).toBe('a1b2c3d reverted in e4f5a6b')
    expect(screen.queryByRole('button', { name: 'Revert' })).toBeNull()
  })

  it('says a plugin that failed to reload kept its previous version', () => {
    show({ change: turn({ commits: [], loads: [{ plugin: 'weather', loaded: false }] }) })

    expect(screen.getByText('weather did not reload; the previous version is running')).toBeTruthy()
  })

  it("shows git's reason in an alert when the revert fails", async () => {
    show({ change: turn(), onRevert: () => Promise.resolve('CONFLICT (content)') })

    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not revert a1b2c3d: CONFLICT (content)'
    )
  })

  it('counts unmerged commits with Merge, which merges the thread', () => {
    const onMerge = vi.fn(() => Promise.resolve(null))
    show({ change: turn(), merge: { unmerged: 2, lastMerge: null }, onMerge })

    expect(screen.getByText('2 commits not merged')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))

    expect(onMerge).toHaveBeenCalledOnce()
  })

  it('shows the last merge when nothing is left to merge', () => {
    show({ change: turn(), merge: { unmerged: 0, lastMerge: { sha: 'f00dbabe1234' } } })

    expect(screen.getByText(/Merged in/).textContent).toBe('Merged in f00dbab')
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()
  })
})

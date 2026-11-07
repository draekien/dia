// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react'
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RailCardView, toggleRail, useRailLayout } from '../lib/session-rail'
import { appRegistry } from '../lib/workspace-atoms'
import { RailToggle, SessionRail } from './session-rail'
import { TooltipProvider } from './ui/tooltip'

const COLUMN = 768
const CARD_SPACE = 320

const card = (id: string, order: number, title: string): RailCardView => ({
  key: { plugin: 'chat', id },
  id,
  order,
  title,
  component: ({ paneId }) => <p>{`${title} body for ${paneId}`}</p>
})

const CARDS = [card('context', 10, 'Context'), card('task-list', 20, 'Task list')]

const fitCards = (fits: boolean) =>
  renderHook(() => useRailLayout(fits ? COLUMN + CARD_SPACE : COLUMN, COLUMN))

const showRail = () =>
  render(
    <RegistryContext.Provider value={appRegistry}>
      <TooltipProvider>
        <RailToggle />
        <SessionRail paneId="pane-1" cards={CARDS} />
        <p>transcript</p>
      </TooltipProvider>
    </RegistryContext.Provider>
  )

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  localStorage.clear()
  appRegistry.reset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  appRegistry.reset()
})

describe('SessionRail', () => {
  it('shows every card body for the pane, in the order given', () => {
    fitCards(true)
    showRail()
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Context',
      'Task list'
    ])
    expect(screen.getByText('Context body for pane-1')).toBeTruthy()
  })

  it('hides a card unchecked in a card menu', () => {
    fitCards(true)
    showRail()
    fireEvent.click(screen.getByRole('button', { name: 'Task list card options' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Context' }))
    expect(screen.queryByText('Context body for pane-1')).toBeNull()
    expect(screen.getByText('Task list body for pane-1')).toBeTruthy()
  })

  it('offers to show every card once all are hidden', () => {
    localStorage.setItem('dia.rail.hidden', JSON.stringify(['chat.context', 'chat.task-list']))
    fitCards(true)
    showRail()
    fireEvent.click(screen.getByRole('button', { name: 'Show cards' }))
    expect(screen.getAllByRole('heading')).toHaveLength(2)
  })

  it('renders nothing while the cards do not fit and are not shown temporarily', () => {
    fitCards(false)
    showRail()
    expect(screen.queryByRole('complementary', { name: 'Session details' })).toBeNull()
  })

  it('closes temporarily shown cards when the pointer goes down outside them', () => {
    fitCards(false)
    toggleRail()
    showRail()
    expect(screen.getByRole('complementary', { name: 'Session details' })).toBeTruthy()

    fireEvent.pointerDown(screen.getByText('transcript'))

    expect(screen.queryByRole('complementary', { name: 'Session details' })).toBeNull()
  })

  it('keeps temporarily shown cards open while the user works in a card menu', () => {
    fitCards(false)
    toggleRail()
    showRail()
    fireEvent.click(screen.getByRole('button', { name: 'Context card options' }))

    fireEvent.pointerDown(screen.getByRole('checkbox', { name: 'Task list' }))

    expect(screen.getByRole('complementary', { name: 'Session details' })).toBeTruthy()
  })

  it('closes temporarily shown cards on Escape', () => {
    fitCards(false)
    toggleRail()
    showRail()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Session details' })).toBeNull()
  })
})

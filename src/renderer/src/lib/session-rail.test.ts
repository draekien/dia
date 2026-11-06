// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { Effect, Exit, Scope } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addRailCard,
  hiddenRailCardsAtom,
  railCardsAtom,
  railLayout,
  railOpenAtom,
  railPeekAtom,
  railShownAtom,
  revealRailCard,
  setRailCardHidden,
  toggleRail,
  useRailLayout
} from './session-rail'
import { appRegistry } from './workspace-atoms'

const DEFAULT_COLUMN = 768
const CARD_SPACE = 320
const Body = () => null
const ctx = (name: string) => ({
  name,
  provide: () => Effect.void,
  inject: () => Effect.succeedNone,
  whenProvided: () => Effect.void
})

beforeEach(() => {
  localStorage.clear()
  appRegistry.reset()
})
afterEach(() => appRegistry.reset())

const recordFits = (fits: boolean) =>
  renderHook(() =>
    useRailLayout(fits ? DEFAULT_COLUMN + CARD_SPACE : DEFAULT_COLUMN, DEFAULT_COLUMN)
  )

describe('railLayout', () => {
  it('does not fit one px short of the column plus the card space', () => {
    expect(
      railLayout({ width: DEFAULT_COLUMN + CARD_SPACE - 1, columnMax: DEFAULT_COLUMN, open: true })
    ).toEqual({ fits: false, shiftLeft: 0 })
  })

  it('moves the column left by the card space minus its centred margin when there is just room', () => {
    const width = DEFAULT_COLUMN + CARD_SPACE
    const centredMargin = (width - DEFAULT_COLUMN) / 2
    expect(railLayout({ width, columnMax: DEFAULT_COLUMN, open: true })).toEqual({
      fits: true,
      shiftLeft: CARD_SPACE - centredMargin
    })
  })

  it('keeps the column centred once its margin is as wide as the card space', () => {
    expect(
      railLayout({ width: DEFAULT_COLUMN + 2 * CARD_SPACE, columnMax: DEFAULT_COLUMN, open: true })
    ).toEqual({ fits: true, shiftLeft: 0 })
  })

  it('keeps the column centred while the rail is off', () => {
    expect(
      railLayout({ width: DEFAULT_COLUMN + CARD_SPACE, columnMax: DEFAULT_COLUMN, open: false })
    ).toEqual({ fits: true, shiftLeft: 0 })
  })
})

describe('addRailCard', () => {
  it('keys the card by plugin name and id while the scope is open, and removes it on close', () => {
    const scope = Effect.runSync(Scope.make())
    Effect.runSync(
      Scope.provide(
        addRailCard(ctx('chat'), { id: 'context', title: 'Context', component: Body }),
        scope
      )
    )
    expect(appRegistry.get(railCardsAtom).map((card) => card.key)).toEqual(['chat.context'])

    Effect.runSync(Scope.close(scope, Exit.void))
    expect(appRegistry.get(railCardsAtom)).toEqual([])
  })

  it('keeps a reloaded card in its place after the old version closes', () => {
    const first = Effect.runSync(Scope.make())
    const other = Effect.runSync(Scope.make())
    const reloaded = Effect.runSync(Scope.make())
    const add = (name: string, id: string, title: string, scope: Scope.Closeable) =>
      Effect.runSync(Scope.provide(addRailCard(ctx(name), { id, title, component: Body }), scope))

    add('chat', 'context', 'Context', first)
    add('notes', 'notes', 'Notes', other)
    add('chat', 'context', 'Context v2', reloaded)
    Effect.runSync(Scope.close(first, Exit.void))

    expect(appRegistry.get(railCardsAtom).map((card) => card.title)).toEqual([
      'Context v2',
      'Notes'
    ])
  })
})

describe('toggleRail', () => {
  it('turns the saved rail choice off while the cards fit', () => {
    recordFits(true)
    toggleRail()
    expect(appRegistry.get(railOpenAtom)).toBe(false)
    expect(localStorage.getItem('dia.rail.open')).toBe('0')
  })

  it('shows the cards temporarily without changing the saved choice when they do not fit', () => {
    recordFits(false)
    appRegistry.set(railOpenAtom, false)
    toggleRail()
    expect(appRegistry.get(railShownAtom)).toBe(true)
    expect(appRegistry.get(railOpenAtom)).toBe(false)
  })

  it('drops a temporary show when the cards start to fit', () => {
    const hook = renderHook(({ width }) => useRailLayout(width, DEFAULT_COLUMN), {
      initialProps: { width: DEFAULT_COLUMN }
    })
    toggleRail()
    hook.rerender({ width: DEFAULT_COLUMN + CARD_SPACE })
    hook.rerender({ width: DEFAULT_COLUMN })
    expect(appRegistry.get(railPeekAtom)).toBe(false)
  })
})

describe('hidden cards', () => {
  it('saves a hidden card and shows it again', () => {
    setRailCardHidden('chat.context', true)
    expect(JSON.parse(localStorage.getItem('dia.rail.hidden') ?? '')).toEqual(['chat.context'])
    setRailCardHidden('chat.context', false)
    expect(appRegistry.get(hiddenRailCardsAtom)).toEqual([])
  })

  it('treats an unreadable saved list as no hidden cards', () => {
    localStorage.setItem('dia.rail.hidden', '{not json')
    expect(appRegistry.get(hiddenRailCardsAtom)).toEqual([])
  })

  it('reveals a hidden card by unhiding it and showing the cards over the transcript when they do not fit', () => {
    recordFits(false)
    setRailCardHidden('chat.context', true)
    revealRailCard('chat.context')
    expect(appRegistry.get(hiddenRailCardsAtom)).toEqual([])
    expect(appRegistry.get(railShownAtom)).toBe(true)
  })
})

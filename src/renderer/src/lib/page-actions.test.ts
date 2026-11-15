import { Option } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closePage, discardDraft, openDraft, openPage } from './actions'
import { appRegistry, newThreadFormAtom, openPageAtom } from './workspace-atoms'

const DRAFT = '00000000-0000-4000-8000-0000000000d1'
const PANE_A = '00000000-0000-4000-8000-00000000000a'

const openPageId = () =>
  Option.map(appRegistry.get(openPageAtom), (open) => open.key.id).pipe(Option.getOrNull)

afterEach(() => {
  appRegistry.reset()
  vi.unstubAllGlobals()
})

describe('openPage', () => {
  it('keeps the tab the new-thread page opened over, and closes that page', () => {
    vi.stubGlobal('window', { dia: { selectTab: () => {} } })
    appRegistry.set(newThreadFormAtom, Option.some({ draftId: DRAFT, shownBefore: PANE_A }))

    openPage({ plugin: 'example', id: 'greeting' })

    expect(appRegistry.get(openPageAtom)).toEqual(
      Option.some({ key: { plugin: 'example', id: 'greeting' }, shownBefore: PANE_A })
    )
    expect(appRegistry.get(newThreadFormAtom)).toEqual(Option.none())
  })

  it('tells the Host that no tab is visible behind the page', () => {
    const selectTab = vi.fn()
    vi.stubGlobal('window', { dia: { selectTab } })
    appRegistry.set(newThreadFormAtom, Option.some({ draftId: DRAFT, shownBefore: PANE_A }))

    openPage({ plugin: 'example', id: 'greeting' })

    expect(selectTab).toHaveBeenCalledWith(null)
  })

  it('keeps the tab an earlier open page hid', () => {
    vi.stubGlobal('window', { dia: { selectTab: () => {} } })
    appRegistry.set(
      openPageAtom,
      Option.some({ key: { plugin: 'org', id: 'roster' }, shownBefore: PANE_A })
    )

    openPage({ plugin: 'example', id: 'greeting' })

    expect(Option.map(appRegistry.get(openPageAtom), (open) => open.shownBefore)).toEqual(
      Option.some(PANE_A)
    )
  })
})

describe('openDraft over an open page', () => {
  it('returns to the tab the page hid when the draft is discarded', () => {
    const selectTab = vi.fn()
    vi.stubGlobal('window', { dia: { selectTab } })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    appRegistry.set(
      openPageAtom,
      Option.some({ key: { plugin: 'example', id: 'greeting' }, shownBefore: PANE_A })
    )

    openDraft(DRAFT)
    discardDraft(DRAFT)

    expect(selectTab).toHaveBeenLastCalledWith(PANE_A)
  })
})

describe('closePage', () => {
  it('closes the open page it names and shows the tab the page hid', () => {
    const selectTab = vi.fn()
    vi.stubGlobal('window', { dia: { selectTab } })
    appRegistry.set(
      openPageAtom,
      Option.some({ key: { plugin: 'example', id: 'greeting' }, shownBefore: PANE_A })
    )

    closePage({ plugin: 'example', id: 'greeting' })

    expect(openPageId()).toBeNull()
    expect(selectTab).toHaveBeenCalledWith(PANE_A)
  })

  it('leaves another open page open', () => {
    const selectTab = vi.fn()
    vi.stubGlobal('window', { dia: { selectTab } })
    appRegistry.set(
      openPageAtom,
      Option.some({ key: { plugin: 'example', id: 'greeting' }, shownBefore: PANE_A })
    )

    closePage({ plugin: 'org', id: 'greeting' })

    expect(openPageId()).toBe('greeting')
    expect(selectTab).not.toHaveBeenCalled()
  })

  it('selects no tab when the page opened while no tab was visible', () => {
    const selectTab = vi.fn()
    vi.stubGlobal('window', { dia: { selectTab } })
    appRegistry.set(
      openPageAtom,
      Option.some({ key: { plugin: 'example', id: 'greeting' }, shownBefore: null })
    )

    closePage({ plugin: 'example', id: 'greeting' })

    expect(openPageId()).toBeNull()
    expect(selectTab).not.toHaveBeenCalled()
  })
})

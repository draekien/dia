import { ProjectId } from '@shared/domain/project'
import { Option } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelNewAgent, closePage, newAgent, openPage } from './actions'
import { appRegistry, newAgentFormAtom, openPageAtom } from './workspace-atoms'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-000000000001')
const PANE_A = '00000000-0000-4000-8000-00000000000a'

const openPageId = () =>
  Option.map(appRegistry.get(openPageAtom), (open) => open.key.id).pipe(Option.getOrNull)

afterEach(() => {
  appRegistry.reset()
  vi.unstubAllGlobals()
})

describe('openPage', () => {
  it('keeps the tab the New agent form opened over, and closes the form', () => {
    vi.stubGlobal('window', { dia: { selectTab: () => {} } })
    appRegistry.set(newAgentFormAtom, Option.some({ projectId: PROJECT, shownBefore: PANE_A }))

    openPage({ plugin: 'example', id: 'greeting' })

    expect(appRegistry.get(openPageAtom)).toEqual(
      Option.some({ key: { plugin: 'example', id: 'greeting' }, shownBefore: PANE_A })
    )
    expect(appRegistry.get(newAgentFormAtom)).toEqual(Option.none())
  })

  it('tells the Host that no tab is visible behind the page', () => {
    const selectTab = vi.fn()
    vi.stubGlobal('window', { dia: { selectTab } })
    appRegistry.set(newAgentFormAtom, Option.some({ projectId: PROJECT, shownBefore: PANE_A }))

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

describe('newAgent over an open page', () => {
  it('returns to the tab the page hid when the form is cancelled', () => {
    const selectTab = vi.fn()
    vi.stubGlobal('window', { dia: { selectTab } })
    appRegistry.set(
      openPageAtom,
      Option.some({ key: { plugin: 'example', id: 'greeting' }, shownBefore: PANE_A })
    )

    newAgent(PROJECT)
    cancelNewAgent()

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

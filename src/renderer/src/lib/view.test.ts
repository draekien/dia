import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  closesNewThreadForm,
  closesOpenPage,
  type NewThreadForm,
  NewThreadView,
  type OpenPage,
  openNewThreadForm,
  PageView,
  TabView,
  viewOf
} from './view'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-000000000001')
const PANE_A = '00000000-0000-4000-8000-00000000000a'
const PANE_B = '00000000-0000-4000-8000-00000000000b'

const tab = (paneId: string): Tab => ({
  name: AgentName.make('heron'),
  config: {
    paneId,
    cwd: '/repo',
    model: 'm',
    thinkingLevel: 'adaptive',
    permissionMode: 'default'
  },
  archived: false
})

const workspace = (paneIds: ReadonlyArray<string>, visibleTab: string | null): Workspace => ({
  projects: [
    {
      project: {
        projectId: PROJECT,
        directory: '/repo',
        directoryKey: '/repo',
        displayName: 'repo',
        isGitRepo: true
      },
      tabs: paneIds.map(tab)
    }
  ],
  visibleTab
})

const GREETING = { plugin: 'example', id: 'greeting' }

const pageOpenedOver = (shownBefore: string | null): OpenPage => ({
  key: GREETING,
  shownBefore
})

const DRAFT = '00000000-0000-4000-8000-0000000000d1'
const FALLBACK = '00000000-0000-4000-8000-0000000000f0'

const formOpenedOver = (shownBefore: string | null): NewThreadForm => ({
  draftId: DRAFT,
  shownBefore
})

describe('viewOf', () => {
  it('has no view until the workspace loads', () => {
    expect(viewOf(Option.none(), Option.none(), Option.none(), FALLBACK)).toBeUndefined()
  })

  it('shows the open page over the new-thread page and a visible tab', () => {
    const view = viewOf(
      Option.some(workspace([PANE_A], PANE_A)),
      Option.some(formOpenedOver(PANE_A)),
      Option.some(pageOpenedOver(PANE_A)),
      FALLBACK
    )

    expect(view).toEqual(PageView.make(GREETING))
  })

  it('shows the open new-thread page for its draft, even over a visible tab', () => {
    const view = viewOf(
      Option.some(workspace([PANE_A], PANE_A)),
      Option.some(formOpenedOver(PANE_A)),
      Option.none(),
      FALLBACK
    )

    expect(view).toEqual(NewThreadView.make({ draftId: DRAFT }))
  })

  it('shows the visible tab when no new-thread page is open', () => {
    expect(
      viewOf(Option.some(workspace([PANE_A], PANE_A)), Option.none(), Option.none(), FALLBACK)
    ).toEqual(TabView.make({ paneId: PANE_A }))
  })

  it('shows the new-thread page for the fallback draft when no tab is visible', () => {
    expect(
      viewOf(Option.some(workspace([PANE_A], null)), Option.none(), Option.none(), FALLBACK)
    ).toEqual(NewThreadView.make({ draftId: FALLBACK }))
  })

  it('shows the new-thread page for the fallback draft when no project is registered', () => {
    const empty: Workspace = { projects: [], visibleTab: null }

    expect(viewOf(Option.some(empty), Option.none(), Option.none(), FALLBACK)).toEqual(
      NewThreadView.make({ draftId: FALLBACK })
    )
  })
})

describe('closesOpenPage', () => {
  it('closes the page when the workspace shows a different tab', () => {
    expect(closesOpenPage(pageOpenedOver(PANE_A), workspace([PANE_A, PANE_B], PANE_B))).toBe(true)
  })

  it('closes the page when a tab shows after it opened over none', () => {
    expect(closesOpenPage(pageOpenedOver(null), workspace([PANE_A], PANE_A))).toBe(true)
  })

  it('keeps the page while the workspace shows the tab it opened over', () => {
    expect(closesOpenPage(pageOpenedOver(PANE_A), workspace([PANE_A], PANE_A))).toBe(false)
  })

  it('keeps the page while no tab is visible', () => {
    expect(closesOpenPage(pageOpenedOver(PANE_A), workspace([PANE_A], null))).toBe(false)
  })
})

describe('openNewThreadForm', () => {
  const OTHER_DRAFT = '00000000-0000-4000-8000-0000000000d2'

  it('remembers the visible tab when no new-thread page is open', () => {
    expect(openNewThreadForm(Option.none(), DRAFT, PANE_A)).toEqual({
      draftId: DRAFT,
      shownBefore: PANE_A
    })
  })

  it('keeps the tab the open page hid when another draft replaces it', () => {
    expect(openNewThreadForm(Option.some(formOpenedOver(PANE_A)), OTHER_DRAFT, null)).toEqual({
      draftId: OTHER_DRAFT,
      shownBefore: PANE_A
    })
  })
})

describe('closesNewThreadForm', () => {
  it('closes the page when the workspace shows a tab other than the one shown before', () => {
    expect(closesNewThreadForm(formOpenedOver(PANE_A), workspace([PANE_A, PANE_B], PANE_B))).toBe(
      true
    )
  })

  it('closes the page when a tab appears after none was shown', () => {
    expect(closesNewThreadForm(formOpenedOver(null), workspace([PANE_A], PANE_A))).toBe(true)
  })

  it('keeps the page open while the tab shown before is still shown', () => {
    expect(closesNewThreadForm(formOpenedOver(PANE_A), workspace([PANE_A], PANE_A))).toBe(false)
  })

  it('keeps the page open while no tab is shown, even with no project left', () => {
    expect(closesNewThreadForm(formOpenedOver(PANE_A), { projects: [], visibleTab: null })).toBe(
      false
    )
  })
})

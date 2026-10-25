import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  closesNewAgentForm,
  EmptyProjectView,
  FirstRunView,
  type NewAgentForm,
  NewAgentView,
  openNewAgentForm,
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

const formOpenedOver = (shownBefore: string | null): NewAgentForm => ({
  projectId: PROJECT,
  shownBefore
})

describe('viewOf', () => {
  it('has no view until the workspace loads', () => {
    expect(viewOf(Option.none(), Option.none())).toBeUndefined()
  })

  it('shows the New agent form while it is open, even over a visible tab', () => {
    const view = viewOf(
      Option.some(workspace([PANE_A], PANE_A)),
      Option.some(formOpenedOver(PANE_A))
    )

    expect(view).toEqual(NewAgentView.make({ projectId: PROJECT }))
  })

  it('shows the visible tab when the form is closed', () => {
    expect(viewOf(Option.some(workspace([PANE_A], PANE_A)), Option.none())).toEqual(
      TabView.make({ paneId: PANE_A })
    )
  })

  it('shows the first-run screen when no project is registered', () => {
    const empty: Workspace = { projects: [], visibleTab: null }

    expect(viewOf(Option.some(empty), Option.none())).toEqual(FirstRunView.make({}))
  })

  it('offers a new agent when projects exist but no tab is visible', () => {
    expect(viewOf(Option.some(workspace([PANE_A], null)), Option.none())).toEqual(
      EmptyProjectView.make({})
    )
  })
})

describe('openNewAgentForm', () => {
  const OTHER = ProjectId.make('00000000-0000-4000-8000-000000000002')

  it('remembers the visible tab when no form is open', () => {
    expect(openNewAgentForm(Option.none(), PROJECT, PANE_A)).toEqual({
      projectId: PROJECT,
      shownBefore: PANE_A
    })
  })

  it('keeps the tab the open form hid when a form for another project replaces it', () => {
    expect(openNewAgentForm(Option.some(formOpenedOver(PANE_A)), OTHER, null)).toEqual({
      projectId: OTHER,
      shownBefore: PANE_A
    })
  })
})

describe('closesNewAgentForm', () => {
  it('closes the form when the workspace shows a tab other than the one shown before', () => {
    expect(closesNewAgentForm(formOpenedOver(PANE_A), workspace([PANE_A, PANE_B], PANE_B))).toBe(
      true
    )
  })

  it('closes the form when a tab appears after none was shown', () => {
    expect(closesNewAgentForm(formOpenedOver(null), workspace([PANE_A], PANE_A))).toBe(true)
  })

  it('keeps the form open while the tab shown before is still shown', () => {
    expect(closesNewAgentForm(formOpenedOver(PANE_A), workspace([PANE_A], PANE_A))).toBe(false)
  })

  it('keeps the form open while no tab is shown', () => {
    expect(closesNewAgentForm(formOpenedOver(PANE_A), workspace([PANE_A], null))).toBe(false)
  })
})

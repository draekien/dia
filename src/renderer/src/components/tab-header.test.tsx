// @vitest-environment jsdom
import { AgentName, type ProjectEntry, ProjectId, type Workspace } from '@shared/domain/project'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { View } from '../lib/view'
import { TabHeader } from './tab-header'

const shown = vi.hoisted(() => ({
  view: undefined as View | undefined,
  workspace: undefined as Workspace | undefined
}))

vi.mock('../plugin-api', () => ({
  useView: () => shown.view,
  useWorkspace: () => shown.workspace
}))
vi.mock('./window-status', () => ({ WindowStatus: () => <div>window status</div> }))
vi.mock('./transcript-width-toggle', () => ({ TranscriptWidthToggle: () => null }))

const PROJECT_ID = ProjectId.make('00000000-0000-4000-8000-000000000001')
const PANE = '00000000-0000-4000-8000-000000000101'
const WORKTREE = {
  path: 'F:/Dev/dia-worktrees/fix',
  branch: 'fix-anchor',
  sourceRepo: 'F:/Dev/dia'
}

const entry: ProjectEntry = {
  project: {
    projectId: PROJECT_ID,
    directory: 'F:/Dev/dia',
    directoryKey: 'f:/dev/dia',
    displayName: 'dia',
    isGitRepo: true
  },
  tabs: [
    {
      name: AgentName.make('fix-anchor'),
      config: {
        paneId: PANE,
        cwd: 'F:/Dev/dia',
        model: 'm',
        thinkingLevel: 'adaptive',
        permissionMode: 'default',
        worktree: WORKTREE
      },
      archived: false
    }
  ]
}

const show = (view: View | undefined, workspace: Workspace | undefined = undefined) => {
  shown.view = view
  shown.workspace = workspace
  return render(<TabHeader />)
}

afterEach(cleanup)

describe('TabHeader', () => {
  it('shows project then agent for a tab, marking the agent as the current page', () => {
    show({ _tag: 'TabView', paneId: PANE }, { projects: [entry], visibleTab: PANE })

    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' })
    expect(within(crumbs).getByText('dia')).toBeTruthy()
    expect(within(crumbs).getByText('fix-anchor').getAttribute('aria-current')).toBe('page')
  })

  it('shows the worktree branch and the transcript width control for a tab', () => {
    show({ _tag: 'TabView', paneId: PANE }, { projects: [entry], visibleTab: PANE })

    expect(screen.getByText('fix-anchor', { selector: 'span.font-mono' }).textContent).toBe(
      'fix-anchor'
    )
    expect(screen.getByRole('button', { name: 'Transcript width' })).toBeTruthy()
  })

  it('shows project then New agent for the New agent form, without a width control', () => {
    show({ _tag: 'NewAgentView', projectId: PROJECT_ID }, { projects: [entry], visibleTab: null })

    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' })
    expect(within(crumbs).getByText('dia')).toBeTruthy()
    expect(within(crumbs).getByText('New agent').getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: 'Transcript width' })).toBeNull()
  })

  it.each([
    ['the first-run view', { _tag: 'FirstRunView' } as const],
    ['the empty-project view', { _tag: 'EmptyProjectView' } as const],
    ['startup', undefined]
  ])('shows no breadcrumb for %s but keeps the window status', (_name, view) => {
    show(view, { projects: [entry], visibleTab: null })

    expect(screen.queryByRole('navigation', { name: 'breadcrumb' })).toBeNull()
    expect(screen.getByText('window status')).toBeTruthy()
  })

  it('shows no breadcrumb for a New agent form whose project is not in the workspace', () => {
    show(
      { _tag: 'NewAgentView', projectId: ProjectId.make('00000000-0000-4000-8000-0000000000ff') },
      {
        projects: [entry],
        visibleTab: null
      }
    )

    expect(screen.queryByRole('navigation', { name: 'breadcrumb' })).toBeNull()
  })
})

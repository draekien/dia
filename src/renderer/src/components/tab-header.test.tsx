// @vitest-environment jsdom
import { AgentName, type ProjectEntry, ProjectId, type Workspace } from '@shared/domain/project'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { View } from '../lib/view'
import { TabHeader } from './tab-header'
import { TooltipProvider } from './ui/tooltip'

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
        backend: 'dia-claude-code',
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
  return render(
    <TooltipProvider>
      <TabHeader />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('TabHeader', () => {
  it('shows project then agent for a tab, marking the agent as the current page', () => {
    show({ _tag: 'TabView', paneId: PANE }, { projects: [entry], visibleTab: PANE })

    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' })
    expect(within(crumbs).getByText('dia')).toBeTruthy()
    expect(within(crumbs).getByText('fix-anchor').getAttribute('aria-current')).toBe('page')
  })

  it('shows only the tab name when a plugin owns the tab’s project', () => {
    const owned = { ...entry, project: { ...entry.project, owner: 'dia-org' } }
    show({ _tag: 'TabView', paneId: PANE }, { projects: [owned], visibleTab: PANE })

    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' })
    expect(within(crumbs).queryByText('dia')).toBeNull()
    expect(within(crumbs).getByText('fix-anchor').getAttribute('aria-current')).toBe('page')
  })

  it('shows the worktree branch, the transcript width control and the rail toggle for a tab', () => {
    show({ _tag: 'TabView', paneId: PANE }, { projects: [entry], visibleTab: PANE })

    expect(screen.getByText('fix-anchor', { selector: 'span.font-mono' }).textContent).toBe(
      'fix-anchor'
    )
    expect(screen.getByRole('button', { name: 'Transcript width' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Session details' })).toBeTruthy()
  })

  it('shows New thread for the new-thread page, without a width control', () => {
    show(
      { _tag: 'NewThreadView', draftId: '00000000-0000-4000-8000-0000000000aa' },
      { projects: [entry], visibleTab: null }
    )

    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' })
    expect(within(crumbs).getByText('New thread').getAttribute('aria-current')).toBe('page')
    expect(within(crumbs).queryByText('dia')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Transcript width' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Session details' })).toBeNull()
  })

  it('shows no breadcrumb during startup but keeps the window status', () => {
    show(undefined, { projects: [entry], visibleTab: null })

    expect(screen.queryByRole('navigation', { name: 'breadcrumb' })).toBeNull()
    expect(screen.getByText('window status')).toBeTruthy()
  })
})

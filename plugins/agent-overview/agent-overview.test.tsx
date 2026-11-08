// @vitest-environment jsdom

import { SidebarProvider, Toaster, TooltipProvider } from '@dia/renderer-plugin'
import {
  type AgentSummary,
  NoActivity,
  StatusIdle,
  StatusNeedsInput,
  StatusWorking,
  ToolUse
} from '@shared/domain/agent-summary'
import type { AttachedSession } from '@shared/domain/attached-session'
import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentOverview } from './agent-overview'

const state = vi.hoisted(() => ({
  workspace: undefined as Workspace | undefined,
  summaries: new Map<string, AgentSummary>(),
  attached: [] as ReadonlyArray<AttachedSession>
}))

vi.mock('@dia/renderer-plugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dia/renderer-plugin')>()),
  useWorkspace: () => state.workspace,
  useAgentSummaries: () => state.summaries,
  useAttachedSessions: () => state.attached
}))

const paneId = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`

const tab = (n: number, name: string): Tab => ({
  name: AgentName.make(name),
  config: {
    paneId: paneId(n),
    cwd: '/repo',
    model: 'm',
    thinkingLevel: 'adaptive',
    permissionMode: 'default'
  },
  archived: false
})

const entry = (n: number, displayName: string, tabs: ReadonlyArray<Tab>) => ({
  project: {
    projectId: ProjectId.make(`00000000-0000-4000-8000-00000000000${n}`),
    directory: `/${displayName}`,
    directoryKey: `/${displayName}`,
    displayName,
    isGitRepo: true
  },
  tabs
})

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
  state.attached = []
  state.workspace = {
    projects: [
      entry(1, 'alpha', [tab(1, 'build'), tab(2, 'review')]),
      entry(2, 'beta', [tab(3, 'docs')])
    ],
    visibleTab: paneId(1)
  }
  state.summaries = new Map<string, AgentSummary>([
    [
      paneId(1),
      {
        paneId: paneId(1),
        status: StatusWorking.make({}),
        activity: ToolUse.make({ tool: 'Edit', target: null })
      }
    ],
    [
      paneId(2),
      {
        paneId: paneId(2),
        status: StatusNeedsInput.make({ reason: 'Approve plan' }),
        activity: NoActivity.make({})
      }
    ],
    [paneId(3), { paneId: paneId(3), status: StatusIdle.make({}), activity: NoActivity.make({}) }]
  ])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Harness({ initialOpen }: { readonly initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <TooltipProvider>
      <SidebarProvider open={open} onOpenChange={setOpen}>
        <AgentOverview />
      </SidebarProvider>
    </TooltipProvider>
  )
}

const list = () => screen.getByRole('navigation', { name: 'Projects and agents' })
const tabStops = () => [...list().querySelectorAll<HTMLElement>('[tabindex="0"]')]
const rowNames = () =>
  [...list().querySelectorAll<HTMLElement>('[data-nav^="row:"]')].map((row) =>
    row.getAttribute('aria-label')
  )

describe('AgentOverview expanded', () => {
  it('has exactly one tab stop, the first group header, and the New agent actions are not tab stops', () => {
    render(<Harness initialOpen />)

    const stops = tabStops()

    expect(stops).toHaveLength(1)
    expect(stops[0].dataset.nav).toMatch(/^header:/)
    expect(screen.getByRole('button', { name: 'New agent in alpha' }).tabIndex).toBe(-1)
  })

  it('moves focus down from a header to the most urgent row and back up with the arrow keys', () => {
    render(<Harness initialOpen />)
    const header = tabStops()[0]
    header.focus()

    fireEvent.keyDown(header, { key: 'ArrowDown' })
    const row = document.activeElement as HTMLElement

    expect(row.getAttribute('aria-label')).toBe('review, Needs input. Approve plan')

    fireEvent.keyDown(row, { key: 'ArrowUp' })

    expect(document.activeElement).toBe(header)
  })

  it('opens the rename field on F2', () => {
    render(<Harness initialOpen />)
    const row = screen.getByRole('button', { name: /^review, / })
    row.focus()

    fireEvent.keyDown(row, { key: 'F2' })

    expect(screen.getByRole('textbox', { name: 'Rename review' })).toBeTruthy()
  })

  it('marks the visible tab with aria-current', () => {
    render(<Harness initialOpen />)

    expect(screen.getByRole('button', { name: /^build, / }).getAttribute('aria-current')).toBe(
      'page'
    )
    expect(screen.getByRole('button', { name: /^docs, / }).getAttribute('aria-current')).toBeNull()
  })
})

describe('AgentOverview archived agents', () => {
  const withArchived = () => {
    const alpha = state.workspace?.projects[0]
    if (state.workspace === undefined || alpha === undefined) throw new Error('no workspace')
    state.workspace = {
      ...state.workspace,
      projects: [
        { ...alpha, tabs: [...alpha.tabs, { ...tab(4, 'old-heron'), archived: true }] },
        ...state.workspace.projects.slice(1)
      ]
    }
  }

  it('lists archived agents under a closed Archived toggle that opens them', () => {
    withArchived()
    render(<Harness initialOpen />)
    const toggle = screen.getByRole('button', { name: 'Archived (1)' })
    const closed = [toggle.getAttribute('aria-expanded'), rowNames().length]

    fireEvent.click(toggle)

    expect([closed, toggle.getAttribute('aria-expanded'), rowNames()[2]]).toEqual([
      ['false', 3],
      'true',
      'old-heron, Idle. No activity yet'
    ])
  })

  it('reaches the Archived toggle with the arrow keys after the last row of its project', () => {
    withArchived()
    render(<Harness initialOpen />)
    const lastRow = screen.getByRole('button', { name: /^build, / })
    lastRow.focus()

    fireEvent.keyDown(lastRow, { key: 'ArrowDown' })

    expect(document.activeElement?.textContent).toBe('Archived (1)')
  })

  it('archives an agent without a worktree from the row menu without asking', () => {
    const bridge = { archiveTab: vi.fn(async () => null) }
    Object.assign(window, { dia: bridge })
    render(<Harness initialOpen />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /^docs, / }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))

    expect([bridge.archiveTab.mock.calls, screen.queryByRole('alertdialog')]).toEqual([
      [[paneId(3)]],
      null
    ])
    Reflect.deleteProperty(window, 'dia')
  })

  const openArchivedMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
    fireEvent.contextMenu(screen.getByRole('button', { name: /^old-heron, / }))
  }

  it('offers Unarchive, not Archive, on an archived agent and unarchives it', async () => {
    withArchived()
    const bridge = { unarchiveTab: vi.fn(async () => null) }
    Object.assign(window, { dia: bridge })
    render(<Harness initialOpen />)

    openArchivedMenu()
    const archive = screen.queryByRole('menuitem', { name: 'Archive' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }))

    await waitFor(() => expect(bridge.unarchiveTab).toHaveBeenCalled())
    expect([archive, bridge.unarchiveTab.mock.calls]).toEqual([null, [[paneId(4)]]])
    Reflect.deleteProperty(window, 'dia')
  })

  it('shows why an agent could not be unarchived in an error toast', async () => {
    withArchived()
    const reason = 'Branch dia/old-heron no longer exists'
    Object.assign(window, { dia: { unarchiveTab: vi.fn(async () => reason) } })
    render(
      <Toaster>
        <Harness initialOpen />
      </Toaster>
    )

    openArchivedMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }))

    expect(await screen.findByText('Could not unarchive old-heron')).toBeTruthy()
    expect(screen.getByText(reason)).toBeTruthy()
    Reflect.deleteProperty(window, 'dia')
  })

  it('shows a lost connection while unarchiving in an error toast', async () => {
    withArchived()
    Object.assign(window, {
      dia: { unarchiveTab: vi.fn(async () => Promise.reject(new Error('closed'))) }
    })
    render(
      <Toaster>
        <Harness initialOpen />
      </Toaster>
    )

    openArchivedMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }))

    expect(
      await screen.findByText("The connection to dia's background process was lost.")
    ).toBeTruthy()
    Reflect.deleteProperty(window, 'dia')
  })

  it('asks before deleting an agent', () => {
    render(<Harness initialOpen />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /^docs, / }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))

    expect(screen.getByRole('alertdialog').textContent).toContain('Delete docs?')
  })
})

describe('AgentOverview Assistant group', () => {
  const assistant = (resettable: boolean): AttachedSession => ({
    config: {
      paneId: paneId(9),
      cwd: '/assistant',
      model: 'm',
      thinkingLevel: 'adaptive',
      permissionMode: 'dontAsk'
    },
    projectId: null,
    label: 'Executive assistant',
    caption: '',
    resettable
  })

  const assistantGroup = () => screen.getByRole('group', { name: 'Assistant' })

  it('lists the assistant session under Assistant, named without a project or caption', () => {
    state.attached = [assistant(true)]
    render(<Harness initialOpen />)

    expect(
      [...assistantGroup().querySelectorAll('[data-nav^="row:"]')].map((row) =>
        row.getAttribute('title')
      )
    ).toEqual(['Executive assistant'])
  })

  it('shows no Assistant group without an assistant session', () => {
    render(<Harness initialOpen />)

    expect(screen.queryByRole('group', { name: 'Assistant' })).toBeNull()
  })

  it('starts the session over from its row menu', () => {
    state.attached = [assistant(true)]
    const bridge = { resetAttachedSession: vi.fn() }
    Object.assign(window, { dia: bridge })
    render(<Harness initialOpen />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /^Executive assistant, / }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start over' }))

    expect(bridge.resetAttachedSession.mock.calls).toEqual([[paneId(9)]])
    Reflect.deleteProperty(window, 'dia')
  })

  it('offers only Show for a session its plugin cannot reset', () => {
    state.attached = [assistant(false)]
    render(<Harness initialOpen />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /^Executive assistant, / }))

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Show'])
  })
})

describe('AgentOverview collapsed', () => {
  it('hides the no-projects prompt, which only fits the expanded sidebar', () => {
    state.workspace = { ...state.workspace, projects: [] } as Workspace
    render(<Harness initialOpen={false} />)

    expect(screen.queryByText('No projects yet')).toBeNull()
  })

  it('lists Meta first, then one dot per agent, with a separator before each project', () => {
    render(<Harness initialOpen={false} />)

    const sequence = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-slot="sidebar-menu-button"], [data-nav^="row:"], [data-slot="sidebar-separator"]'
      )
    ].map((node) => {
      if (node.dataset.slot === 'sidebar-separator') return 'separator'
      return node.dataset.nav?.startsWith('row:') ? 'agent' : 'meta'
    })

    expect(sequence).toEqual(['meta', 'separator', 'agent', 'agent', 'separator', 'agent'])
  })

  it('names each dot "project / agent · status · activity", most urgent first', () => {
    render(<Harness initialOpen={false} />)

    expect(rowNames()).toEqual([
      'alpha / review · Needs input · Approve plan',
      'alpha / build · Working · Edit',
      'beta / docs · Idle · No activity yet'
    ])
  })

  it('shows the same text as a tooltip when a dot is focused', async () => {
    render(<Harness initialOpen={false} />)

    screen.getByRole('button', { name: 'beta / docs · Idle · No activity yet' }).focus()

    const tooltip = await waitFor(() => {
      const popup = document.querySelector('[data-slot="tooltip-content"]')
      expect(popup).not.toBeNull()
      return popup
    })
    expect(tooltip?.textContent).toBe('beta / docs · Idle · No activity yet')
  })

  it('has exactly one tab stop and it is an agent row', () => {
    render(<Harness initialOpen={false} />)

    const stops = tabStops()

    expect(stops).toHaveLength(1)
    expect(stops[0].dataset.nav).toMatch(/^row:/)
  })

  it('ignores an active search while collapsed', () => {
    render(<Harness initialOpen />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents and projects' }), {
      target: { value: 'docs' }
    })
    expect(rowNames()).toHaveLength(1)

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })

    expect(rowNames()).toHaveLength(3)
  })

  it('expands the sidebar on Ctrl P', () => {
    render(<Harness initialOpen={false} />)
    const sidebar = () => document.querySelector<HTMLElement>('[data-slot="sidebar"]')

    fireEvent.keyDown(window, { key: 'p', ctrlKey: true })

    expect(sidebar()?.dataset.state).toBe('expanded')
  })
})

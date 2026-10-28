// @vitest-environment jsdom

import { SidebarProvider, TooltipProvider } from '@dia/renderer-plugin'
import {
  type AgentSummary,
  NoActivity,
  StatusIdle,
  StatusNeedsInput,
  StatusWorking,
  ToolUse
} from '@shared/domain/agent-summary'
import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentOverview } from './agent-overview'

const state = vi.hoisted(() => ({
  workspace: undefined as Workspace | undefined,
  summaries: new Map<string, AgentSummary>()
}))

vi.mock('@dia/renderer-plugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dia/renderer-plugin')>()),
  useWorkspace: () => state.workspace,
  useAgentSummaries: () => state.summaries
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

describe('AgentOverview collapsed', () => {
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

    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'beta / docs · Idle · No activity yet'
    )
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

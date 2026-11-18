// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the test holds an archive or delete call open with a manually resolved Promise.

import { actions, SidebarProvider, TooltipProvider } from '@dia/renderer-plugin'
import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import {
  NoActivity,
  type RunSummary,
  StatusIdle,
  StatusNeedsInput,
  StatusWorking,
  ToolUse
} from '@shared/domain/run-summary'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Atom } from 'effect/reactivity'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadsSidebar } from './threads-sidebar'

const state = vi.hoisted(() => ({
  workspace: undefined as Workspace | undefined,
  summaries: new Map<string, RunSummary>(),
  lists: new Map<string, ReadonlyArray<unknown>>(),
  selectTab: (_paneId: string) => {},
  openPage: (_key: unknown) => {}
}))

vi.mock('@dia/renderer-plugin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dia/renderer-plugin')>()
  return {
    ...original,
    actions: {
      ...original.actions,
      selectTab: (paneId: string) => state.selectTab(paneId),
      openPage: (key: unknown) => state.openPage(key)
    },
    useList: (slot: { readonly name: string }) => state.lists.get(slot.name) ?? [],
    useWorkspace: () => state.workspace,
    useRunSummaries: () => state.summaries
  }
})

const paneId = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`

const tab = (n: number, name: string): Tab => ({
  name: AgentName.make(name),
  config: {
    paneId: paneId(n),
    cwd: '/repo',
    model: 'm',
    backend: 'dia-claude-code',
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
  state.lists = new Map()
  state.selectTab = vi.fn()
  state.openPage = vi.fn()
  state.workspace = {
    projects: [
      entry(1, 'alpha', [tab(1, 'build'), tab(2, 'review')]),
      entry(2, 'beta', [tab(3, 'docs')])
    ],
    visibleTab: paneId(1)
  }
  state.summaries = new Map<string, RunSummary>([
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
        <ThreadsSidebar />
      </SidebarProvider>
    </TooltipProvider>
  )
}

const list = () => screen.getByRole('navigation', { name: 'Projects and threads' })
const tabStops = () => [...list().querySelectorAll<HTMLElement>('[tabindex="0"]')]
const rowNames = () =>
  [...list().querySelectorAll<HTMLElement>('[data-nav^="row:"]')].map((row) =>
    row.getAttribute('aria-label')
  )

describe('ThreadsSidebar expanded', () => {
  it('has exactly one tab stop, the first group header, and the New agent actions are not tab stops', () => {
    render(<Harness initialOpen />)

    const stops = tabStops()

    expect(stops).toHaveLength(1)
    expect(stops[0].dataset.nav).toMatch(/^header:/)
    expect(screen.getByRole('button', { name: 'New thread in alpha' }).tabIndex).toBe(-1)
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

describe('ThreadsSidebar row menu', () => {
  const menuEntry = (
    id: string,
    label: string,
    onSelect: (thread: { paneId: string }) => void
  ) => ({
    id,
    order: 1,
    label,
    onSelect,
    key: { plugin: 'dia-text-generation', id }
  })

  it('lists a contributed entry after Rename and calls it with the paneId of the row', () => {
    const onSelect = vi.fn()
    state.lists.set('threads.row-menu', [menuEntry('regenerate', 'Regenerate title', onSelect)])
    render(<Harness initialOpen />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /^docs, / }))
    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Regenerate title' }))

    expect([labels.slice(0, 3), onSelect.mock.calls]).toEqual([
      ['Show', 'RenameF2', 'Regenerate title'],
      [[{ paneId: paneId(3) }]]
    ])
  })

  it('lists contributed entries in the order the list gives them', () => {
    state.lists.set('threads.row-menu', [
      menuEntry('first', 'First entry', vi.fn()),
      menuEntry('second', 'Second entry', vi.fn())
    ])
    render(<Harness initialOpen />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /^docs, / }))

    expect(
      screen
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
        .slice(2, 4)
    ).toEqual(['First entry', 'Second entry'])
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

  it('mutes a thread while it archives, so it neither opens nor offers Archive or Delete', async () => {
    let finish: (reason: string | null) => void = () => undefined
    const bridge = {
      archiveTab: vi.fn(() => new Promise<string | null>((resolve) => (finish = resolve)))
    }
    Object.assign(window, { dia: bridge })
    render(<Harness initialOpen />)
    fireEvent.contextMenu(screen.getByRole('button', { name: /^docs, / }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))

    const row = await screen.findByRole('button', { name: 'docs, Idle. Archiving…' })
    fireEvent.click(row)
    fireEvent.contextMenu(row)

    expect([
      row.getAttribute('aria-disabled'),
      vi.mocked(state.selectTab).mock.calls,
      screen.queryByRole('menuitem', { name: 'Archive' }),
      screen.queryByRole('menuitem', { name: 'Delete…' })
    ]).toEqual(['true', [], null, null])
    await act(async () => finish(null))
    Reflect.deleteProperty(window, 'dia')
  })

  it('does not open a thread that is archiving from Enter in the search box', async () => {
    let finish: (reason: string | null) => void = () => undefined
    Object.assign(window, {
      dia: { archiveTab: () => new Promise<string | null>((resolve) => (finish = resolve)) }
    })
    render(<Harness initialOpen />)
    fireEvent.contextMenu(screen.getByRole('button', { name: /^docs, / }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    const search = screen.getByRole('searchbox', { name: 'Search threads and projects' })

    fireEvent.change(search, { target: { value: 'docs' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(vi.mocked(state.selectTab).mock.calls).toEqual([])
    await act(async () => finish(null))
    Reflect.deleteProperty(window, 'dia')
  })

  it('asks before deleting an agent', () => {
    render(<Harness initialOpen />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /^docs, / }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))

    expect(screen.getByRole('alertdialog').textContent).toContain('Delete docs?')
  })
})

describe('ThreadsSidebar without open threads', () => {
  const withoutOpenThreads = () => {
    const alpha = state.workspace?.projects[0]
    if (state.workspace === undefined || alpha === undefined) throw new Error('no workspace')
    state.workspace = {
      ...state.workspace,
      projects: [{ ...alpha, tabs: alpha.tabs.map((each) => ({ ...each, archived: true })) }]
    }
  }

  it('lists a project that has an open thread and not one that has none', () => {
    withoutOpenThreads()
    const beta = entry(2, 'beta', [tab(3, 'docs')])
    const gamma = entry(3, 'gamma', [])
    if (state.workspace === undefined) throw new Error('no workspace')
    state.workspace = { ...state.workspace, projects: [...state.workspace.projects, beta, gamma] }
    render(<Harness initialOpen />)

    const groups = within(list())
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'))

    expect(groups).toEqual(['beta'])
  })

  it('shows the empty state when no project has an open thread', () => {
    withoutOpenThreads()
    render(<Harness initialOpen />)

    expect([
      screen.getByText('No threads').getAttribute('data-slot'),
      screen.getByText('Threads you start appear here.').getAttribute('data-slot'),
      screen.queryByText('No projects yet')
    ]).toEqual(['empty-title', 'empty-description', null])
  })

  it('starts a thread from the empty state button', () => {
    withoutOpenThreads()
    const newThread = vi.spyOn(actions, 'newThread').mockImplementation(() => undefined)
    render(<Harness initialOpen />)

    fireEvent.click(within(list()).getByRole('button', { name: 'New thread' }))

    expect(newThread.mock.calls).toEqual([[]])
  })

  it('names the search instead when a search matches nothing', () => {
    render(<Harness initialOpen />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads and projects' }), {
      target: { value: 'zzz' }
    })

    expect(screen.getByText('No threads or projects match "zzz".')).toBeTruthy()
    expect(screen.queryByText('Threads you start appear here.')).toBeNull()
  })

  it('keeps the empty state during a search when no project has an open thread', () => {
    withoutOpenThreads()
    render(<Harness initialOpen />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads and projects' }), {
      target: { value: 'zzz' }
    })

    expect([
      screen.queryByText('Threads you start appear here.') !== null,
      screen.queryByText('No threads or projects match "zzz".')
    ]).toEqual([true, null])
  })

  it('hides the empty state while the sidebar is collapsed', () => {
    withoutOpenThreads()
    render(<Harness initialOpen={false} />)

    expect(screen.queryByText('No threads')).toBeNull()
  })
})

describe('ThreadsSidebar collapsed', () => {
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

  it('names each dot "project / agent, status, activity", most urgent first', () => {
    render(<Harness initialOpen={false} />)

    expect(rowNames()).toEqual([
      'alpha / review, Needs input, Approve plan',
      'alpha / build, Working, Edit',
      'beta / docs, Idle, No activity yet'
    ])
  })

  it('shows the same text as a tooltip when a dot is focused', async () => {
    render(<Harness initialOpen={false} />)

    screen.getByRole('button', { name: 'beta / docs, Idle, No activity yet' }).focus()

    const tooltip = await waitFor(() => {
      const popup = document.querySelector('[data-slot="tooltip-content"]')
      expect(popup).not.toBeNull()
      return popup
    })
    expect(tooltip?.textContent).toBe('beta / docs, Idle, No activity yet')
  })

  it('has exactly one tab stop and it is an agent row', () => {
    render(<Harness initialOpen={false} />)

    const stops = tabStops()

    expect(stops).toHaveLength(1)
    expect(stops[0].dataset.nav).toMatch(/^row:/)
  })

  it('ignores an active search while collapsed', () => {
    render(<Harness initialOpen />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads and projects' }), {
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

const assistantPage = (tab: string | null) => ({
  id: 'assistant',
  order: 10.5,
  label: 'Assistant',
  icon: () => null,
  component: () => null,
  tab: Atom.make<string | null>(tab),
  key: { plugin: 'dia-org', id: 'assistant' }
})

describe('ThreadsSidebar page entries', () => {
  it('selects the tab a page entry names and shows that tab’s status', () => {
    state.lists.set('layout.pages', [assistantPage(paneId(2))])
    render(<Harness initialOpen />)

    fireEvent.click(screen.getByRole('button', { name: 'Assistant, Needs input' }))

    expect(state.selectTab).toHaveBeenCalledWith(paneId(2))
  })

  it('opens the page of an entry that names no tab', () => {
    const page = assistantPage(null)
    state.lists.set('layout.pages', [page])
    render(<Harness initialOpen />)

    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }))

    expect(state.openPage).toHaveBeenCalledWith(page.key)
  })
})

describe('ThreadsSidebar sections', () => {
  const section = {
    id: 'agents',
    order: 10,
    component: ({ iconMode }: { readonly iconMode: boolean }) => (
      <p>{iconMode ? 'agents as dots' : 'agents as rows'}</p>
    ),
    key: { plugin: 'dia-org', id: 'agents' }
  }

  it('draws each section between the pages and the Threads label', () => {
    state.lists.set('layout.sections', [section])
    render(<Harness initialOpen />)

    const order = [screen.getByText('agents as rows'), screen.getByText('Threads')]
    expect(
      order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('tells a section the sidebar is collapsed to its rail', () => {
    state.lists.set('layout.sections', [section])
    render(<Harness initialOpen={false} />)

    expect(screen.getByText('agents as dots')).toBeTruthy()
  })
})

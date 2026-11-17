// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the test holds an archive or delete call open with a manually resolved Promise.

import { Toaster } from '@dia/renderer-plugin'
import { AgentName, ProjectId, type Tab, type Workspace } from '@shared/domain/project'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchivedThreadsSettings } from './archived-threads-settings'

const state = vi.hoisted(() => ({
  workspace: undefined as Workspace | undefined,
  calls: [] as Array<string>,
  selectTab: (_paneId: string) => {}
}))

vi.mock('@dia/renderer-plugin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dia/renderer-plugin')>()
  return {
    ...original,
    actions: {
      ...original.actions,
      selectTab: (paneId: string) => state.selectTab(paneId)
    },
    closeSettings: () => state.calls.push('closeSettings'),
    useWorkspace: () => state.workspace
  }
})

const OLD_HERON = '00000000-0000-4000-8000-000000000104'

const tab = (n: number, name: string, archived: boolean): Tab => ({
  name: AgentName.make(name),
  config: {
    paneId: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
    cwd: '/dia',
    model: 'm',
    thinkingLevel: 'adaptive',
    permissionMode: 'default'
  },
  archived
})

const project = (n: number, displayName: string, tabs: ReadonlyArray<Tab>) => ({
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
  state.calls = []
  state.selectTab = (paneId) => {
    state.calls.push(`selectTab ${paneId}`)
  }
  state.workspace = {
    projects: [
      project(1, 'dia', [
        tab(1, 'live', false),
        tab(4, 'old-heron', true),
        { ...tab(5, 'owned', true), owner: 'dia-org' }
      ]),
      project(2, 'skills', [tab(6, 'quiet', false)]),
      project(3, 'site', [tab(7, 'old-site', true)])
    ],
    visibleTab: null
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'dia')
})

const openMenu = async (name: string, item: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: item }))
}

describe('ArchivedThreadsSettings', () => {
  it('groups archived user threads under their projects in project order', () => {
    render(<ArchivedThreadsSettings />)

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    const rows = screen.getAllByRole('button', { name: /^(old-heron|old-site)$/ })

    expect([headings, rows.map((row) => row.textContent)]).toEqual([
      ['dia', 'site'],
      ['old-heron', 'old-site']
    ])
  })

  it('shows an empty state when no thread is archived', () => {
    state.workspace = { projects: [project(1, 'dia', [tab(1, 'live', false)])], visibleTab: null }

    render(<ArchivedThreadsSettings />)

    expect(screen.getByText('No archived threads')).toBeTruthy()
  })

  it('closes Settings and then shows the thread when its row is clicked', () => {
    render(<ArchivedThreadsSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'old-heron' }))

    expect(state.calls).toEqual(['closeSettings', `selectTab ${OLD_HERON}`])
  })

  it('mutes a thread while it is deleted, so it neither opens nor shows its menu', async () => {
    let finish: (reason: string | null) => void = () => undefined
    const deleteTab = vi.fn(() => new Promise<string | null>((resolve) => (finish = resolve)))
    Object.assign(window, { dia: { deleteTab } })
    render(<ArchivedThreadsSettings />)
    await openMenu('old-site', 'Delete…')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    const row = await screen.findByRole('button', { name: /^old-site/ })
    fireEvent.click(row)

    expect([
      row.textContent,
      row.getAttribute('aria-disabled'),
      state.calls,
      screen.queryByRole('button', { name: 'Actions for old-site' })
    ]).toEqual(['old-siteDeleting…', 'true', [], null])
    await act(async () => finish(null))
  })

  it('unarchives the thread from its menu', async () => {
    const unarchiveTab = vi.fn(async () => null)
    Object.assign(window, { dia: { unarchiveTab } })
    render(<ArchivedThreadsSettings />)

    await openMenu('old-heron', 'Unarchive')

    await waitFor(() => expect(unarchiveTab.mock.calls).toEqual([[OLD_HERON]]))
  })

  it('shows why a thread could not be unarchived in an error toast', async () => {
    const reason = 'Branch dia/old-heron no longer exists'
    Object.assign(window, { dia: { unarchiveTab: vi.fn(async () => reason) } })
    render(
      <Toaster>
        <ArchivedThreadsSettings />
      </Toaster>
    )

    await openMenu('old-heron', 'Unarchive')

    expect(await screen.findByText('Could not unarchive old-heron')).toBeTruthy()
    expect(screen.getByText(reason)).toBeTruthy()
  })

  it('shows a lost connection while unarchiving in an error toast', async () => {
    Object.assign(window, {
      dia: { unarchiveTab: vi.fn(async () => Promise.reject(new Error('closed'))) }
    })
    render(
      <Toaster>
        <ArchivedThreadsSettings />
      </Toaster>
    )

    await openMenu('old-heron', 'Unarchive')

    expect(
      await screen.findByText("The connection to dia's background process was lost.")
    ).toBeTruthy()
  })

  it('asks before deleting and deletes the thread once confirmed', async () => {
    const deleteTab = vi.fn(async () => null)
    Object.assign(window, { dia: { deleteTab } })
    render(<ArchivedThreadsSettings />)

    await openMenu('old-heron', 'Delete…')
    const dialog = screen.getByRole('alertdialog')
    const before = deleteTab.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(dialog.textContent).toContain('Delete old-heron?')
    expect(before).toBe(0)
    await waitFor(() => expect(deleteTab.mock.calls).toEqual([[OLD_HERON]]))
  })
})

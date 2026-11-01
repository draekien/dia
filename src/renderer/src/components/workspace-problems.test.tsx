// @vitest-environment jsdom
import {
  ImportConflict,
  UnreadableAgent,
  UnreadableProject,
  type WorkspaceProblem
} from '@shared/domain/workspace-problem'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importLabel, WorkspaceProblemsBanner } from './workspace-problems'

const AGENT = UnreadableAgent.make({
  agentId: 'agent-1',
  name: 'brave-otter',
  project: 'dia',
  reason: 'Expected "low" | "high", got "ultra"'
})

const PROJECT = UnreadableProject.make({
  projectId: 'project-1',
  name: 'old-repo',
  agents: 3,
  reason: 'Expected a UUID'
})

const CONFLICT = ImportConflict.make({
  agentId: 'pane-b',
  name: 'calm-heron',
  project: 'dia',
  session: { value: '9c37a1b2-0000-4000-8000-000000000001', heldBy: 'brave-otter' }
})

const installBridge = (initial: ReadonlyArray<WorkspaceProblem>) => {
  let current = initial
  const bridge = {
    list: vi.fn(async () => current),
    deleteRow: vi.fn(async (_row: { kind: string; id: string }): Promise<string | null> => {
      current = current.filter((problem) => problem !== AGENT && problem !== PROJECT)
      return null
    }),
    resolveImportConflict: vi.fn(
      async (_agentId: string, _resolution: string): Promise<string | null> => {
        current = current.filter((problem) => problem !== CONFLICT)
        return null
      }
    )
  }
  Object.assign(window, { dia: { workspaceProblems: bridge } })
  return bridge
}

const openReview = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
  return screen.findByRole('dialog')
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('WorkspaceProblemsBanner', () => {
  it('renders nothing when there is no problem', async () => {
    const bridge = installBridge([])

    const { container } = render(<WorkspaceProblemsBanner />)

    await waitFor(() => expect(bridge.list).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('counts every problem in the strip', async () => {
    installBridge([AGENT, CONFLICT])

    render(<WorkspaceProblemsBanner />)

    await screen.findByText('2 workspace problems need your decision')
  })

  it('lists an unreadable agent with its project and reason', async () => {
    installBridge([AGENT])
    render(<WorkspaceProblemsBanner />)

    const dialog = await openReview()

    expect(dialog.textContent).toContain('brave-otter')
    expect(dialog.textContent).toContain('Agent in dia')
    expect(dialog.textContent).toContain('got "ultra"')
  })

  it('hides a problem kept for later without asking the Host to change anything', async () => {
    const bridge = installBridge([AGENT, CONFLICT])
    render(<WorkspaceProblemsBanner />)
    await openReview()

    fireEvent.click(screen.getByRole('button', { name: 'Keep for later' }))

    await screen.findByText('A workspace problem needs your decision')
    expect(bridge.deleteRow).not.toHaveBeenCalled()
  })

  it('deletes an unreadable project only after the confirmation names its agents', async () => {
    const bridge = installBridge([PROJECT])
    render(<WorkspaceProblemsBanner />)
    await openReview()

    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }))
    const confirmation = await screen.findByRole('alertdialog')
    expect(bridge.deleteRow).not.toHaveBeenCalled()
    expect(confirmation.textContent).toContain('Delete project old-repo?')
    expect(confirmation.textContent).toContain('3 agents')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(bridge.deleteRow.mock.calls).toEqual([[{ kind: 'project', id: 'project-1' }]])
    )
  })

  it('imports a conflict with the shared session dropped and removes it from the list', async () => {
    const bridge = installBridge([CONFLICT])
    const { container } = render(<WorkspaceProblemsBanner />)
    const dialog = await openReview()
    expect(dialog.textContent).toContain('Shares session 9c37a1b2… with brave-otter')

    fireEvent.click(screen.getByRole('button', { name: 'Import without its session' }))

    await waitFor(() => expect(container.textContent).toBe(''))
    expect(bridge.resolveImportConflict.mock.calls).toEqual([['pane-b', 'import']])
  })

  it('shows the reason a resolution failed under its row', async () => {
    const bridge = installBridge([CONFLICT])
    bridge.resolveImportConflict.mockResolvedValueOnce('Its project is being removed.')
    render(<WorkspaceProblemsBanner />)
    await openReview()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Its project is being removed.')
  })
})

describe('importLabel', () => {
  it('names each value a stored agent holds, or none', () => {
    const held = { value: 'x', heldBy: 'y' }
    const base = { agentId: 'a', name: 'n', project: 'p' }

    expect([
      importLabel(ImportConflict.make({ ...base, session: held })),
      importLabel(ImportConflict.make({ ...base, worktree: held })),
      importLabel(ImportConflict.make({ ...base, session: held, worktree: held })),
      importLabel(ImportConflict.make(base))
    ]).toEqual([
      'Import without its session',
      'Import without its worktree',
      'Import without its session and worktree',
      'Import'
    ])
  })
})

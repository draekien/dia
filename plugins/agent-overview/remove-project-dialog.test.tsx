// @vitest-environment jsdom

import { SessionId } from '@shared/domain/pane'
import { AgentName, type ProjectEntry, ProjectId, type Tab } from '@shared/domain/project'
import {
  AgentItem,
  ProjectRemoved,
  type RemovalProgress,
  Removed,
  RemoveFailed,
  Removing,
  WorktreeItem
} from '@shared/domain/project-removal'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoveProjectDialog, removalItems } from './remove-project-dialog'

const PROJECT_ID = ProjectId.make('00000000-0000-4000-8000-000000000001')
const PANE_A = '00000000-0000-4000-8000-000000000101'
const PANE_B = '00000000-0000-4000-8000-000000000102'
const WORKTREE = {
  path: 'F:/Dev/dia-worktrees/fix-anchor',
  branch: 'fix-anchor',
  sourceRepo: 'F:/Dev/dia'
}

const tab = (paneId: string, name: string, extra: Partial<Tab> = {}): Tab => ({
  name: AgentName.make(name),
  config: {
    paneId,
    cwd: 'F:/Dev/dia',
    model: 'm',
    thinkingLevel: 'adaptive',
    permissionMode: 'default'
  },
  archived: false,
  ...extra
})

const withWorktreeAndSession = tab(PANE_A, 'fix-anchor', {
  config: { ...tab(PANE_A, 'fix-anchor').config, worktree: WORKTREE },
  sessionId: SessionId.make('session-a')
})

const entry = (tabs: ReadonlyArray<Tab>): ProjectEntry => ({
  project: {
    projectId: PROJECT_ID,
    directory: 'F:/Dev/dia',
    directoryKey: 'f:/dev/dia',
    displayName: 'dia',
    isGitRepo: true
  },
  tabs
})

type RemoveFake = (
  projectId: string,
  force: boolean,
  onProgress: (progress: RemovalProgress) => void
) => Promise<void>

const installBridge = (removeProject: RemoveFake) => {
  const bridge = { removeProject: vi.fn(removeProject) }
  Object.assign(window, { dia: bridge })
  return bridge
}

const confirmAndRemove = () => {
  fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'dia' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('removalItems', () => {
  it('lists each agent, then its worktree, agent by agent, and no transcript of a tab with a session', () => {
    const items = removalItems(entry([withWorktreeAndSession, tab(PANE_B, 'docs')]))

    expect(items).toEqual([
      AgentItem.make({ paneId: PANE_A, name: AgentName.make('fix-anchor') }),
      WorktreeItem.make({ path: WORKTREE.path }),
      AgentItem.make({ paneId: PANE_B, name: AgentName.make('docs') })
    ])
  })

  it('lists nothing for a project with no agents', () => {
    expect(removalItems(entry([]))).toEqual([])
  })
})

describe('RemoveProjectDialog', () => {
  it('lists only the agent and worktree rows of a tab with a session', () => {
    installBridge(async () => undefined)
    render(
      <RemoveProjectDialog entry={entry([withWorktreeAndSession])} onClose={() => undefined} />
    )

    const rows = within(screen.getByRole('list', { name: 'Items to remove' }))
      .getAllByRole('listitem')
      .map((row) => row.textContent)

    expect(rows).toEqual(['Agentfix-anchor', `Worktree${WORKTREE.path}`])
  })

  it('keeps Remove disabled until the project name is typed exactly', () => {
    installBridge(async () => undefined)
    render(<RemoveProjectDialog entry={entry([tab(PANE_B, 'docs')])} onClose={() => undefined} />)
    const input = screen.getByLabelText(/to confirm/)
    const remove = screen.getByRole('button', { name: 'Remove' })

    fireEvent.change(input, { target: { value: 'di' } })
    const disabledWhilePartial = remove.hasAttribute('disabled')
    fireEvent.change(input, { target: { value: 'dia' } })

    expect([disabledWhilePartial, remove.hasAttribute('disabled')]).toEqual([true, false])
  })

  it('removes without force and closes once the project is removed', async () => {
    const bridge = installBridge(async (_id, _force, onProgress) => {
      onProgress(
        Removed.make({ item: AgentItem.make({ paneId: PANE_B, name: AgentName.make('docs') }) })
      )
      onProgress(ProjectRemoved.make({}))
    })
    const onClose = vi.fn()
    render(<RemoveProjectDialog entry={entry([tab(PANE_B, 'docs')])} onClose={onClose} />)

    confirmAndRemove()

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(bridge.removeProject.mock.calls[0].slice(0, 2)).toEqual([PROJECT_ID, false])
  })

  it('shows the reason of a failed item and stays open when the project is not removed', async () => {
    const worktree = WorktreeItem.make({ path: WORKTREE.path })
    installBridge(async (_id, _force, onProgress) => {
      onProgress(Removing.make({ item: worktree }))
      onProgress(
        RemoveFailed.make({ item: worktree, reason: 'The worktree has uncommitted changes' })
      )
    })
    const onClose = vi.fn()
    render(<RemoveProjectDialog entry={entry([withWorktreeAndSession])} onClose={onClose} />)

    confirmAndRemove()

    await screen.findByText('The worktree has uncommitted changes')
    expect(screen.getByRole('button', { name: 'Remove again' })).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('removes with force when "Remove anyway" is chosen after a failure', async () => {
    const worktree = WorktreeItem.make({ path: WORKTREE.path })
    const bridge = installBridge(async (_id, force, onProgress) => {
      if (force) onProgress(ProjectRemoved.make({}))
      else onProgress(RemoveFailed.make({ item: worktree, reason: 'locked' }))
    })
    const onClose = vi.fn()
    render(<RemoveProjectDialog entry={entry([withWorktreeAndSession])} onClose={onClose} />)
    confirmAndRemove()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove anyway' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(bridge.removeProject.mock.calls.map((call) => call[1])).toEqual([false, true])
  })

  it('reports a lost connection when the removal request rejects', async () => {
    installBridge(async () => {
      throw new Error('disconnected')
    })
    render(<RemoveProjectDialog entry={entry([tab(PANE_B, 'docs')])} onClose={() => undefined} />)

    confirmAndRemove()

    expect(await screen.findByRole('button', { name: 'Check again' })).toBeTruthy()
  })
})

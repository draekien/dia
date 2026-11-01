// @vitest-environment jsdom

import { AgentName, type Tab } from '@shared/domain/project'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetireAgentDialog } from './retire-agent-dialog'

const PANE = '00000000-0000-4000-8000-000000000101'
const WORKTREE = {
  path: 'F:/Dev/dia-worktrees/brave-otter',
  branch: 'dia/brave-otter',
  sourceRepo: 'F:/Dev/dia'
}

const tab = (extra: Partial<Tab['config']> = {}): Tab => ({
  name: AgentName.make('brave-otter'),
  config: {
    paneId: PANE,
    cwd: 'F:/Dev/dia',
    model: 'm',
    thinkingLevel: 'adaptive',
    permissionMode: 'default',
    ...extra
  },
  archived: false
})

const installBridge = (result: Promise<string | null>) => {
  const bridge = {
    archiveTab: vi.fn(() => result),
    deleteTab: vi.fn(() => result)
  }
  Object.assign(window, { dia: bridge })
  return bridge
}

const dialogText = () => screen.getByRole('alertdialog').textContent ?? ''

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('RetireAgentDialog', () => {
  it('names the worktree it deletes and the branch and transcripts that stay', () => {
    installBridge(Promise.resolve(null))
    render(
      <RetireAgentDialog
        tab={tab({ worktree: WORKTREE })}
        retirement="delete"
        onClose={() => undefined}
      />
    )

    expect([
      dialogText().includes(WORKTREE.path),
      dialogText().includes(`Its branch ${WORKTREE.branch} and its Claude Code transcripts stay`)
    ]).toEqual([true, true])
  })

  it('does not claim to stop an archived agent', () => {
    installBridge(Promise.resolve(null))
    render(
      <RetireAgentDialog
        tab={{ ...tab(), archived: true }}
        retirement="delete"
        onClose={() => undefined}
      />
    )

    expect(dialogText()).not.toContain('dia stops this agent')
  })

  it('deletes the tab it was opened for and closes once it is deleted', async () => {
    const bridge = installBridge(Promise.resolve(null))
    const onClose = vi.fn()
    render(<RetireAgentDialog tab={tab()} retirement="delete" onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect([bridge.deleteTab.mock.calls, bridge.archiveTab.mock.calls]).toEqual([[[PANE]], []])
  })

  it('archives through archiveTab when opened to archive', async () => {
    const bridge = installBridge(Promise.resolve(null))
    render(
      <RetireAgentDialog
        tab={tab({ worktree: WORKTREE })}
        retirement="archive"
        onClose={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(bridge.archiveTab.mock.calls).toEqual([[PANE]]))
  })

  it('shows why the worktree was not removed, stays open and offers Try again', async () => {
    installBridge(Promise.resolve('The worktree directory is still on disk'))
    const onClose = vi.fn()
    render(
      <RetireAgentDialog tab={tab({ worktree: WORKTREE })} retirement="archive" onClose={onClose} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

    const alert = await screen.findByRole('alert')
    expect([
      alert.textContent,
      screen.queryByRole('button', { name: 'Try again' }) !== null,
      onClose.mock.calls.length
    ]).toEqual(['Not archived: The worktree directory is still on disk', true, 0])
  })
})

// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the test holds an archive or delete call open with a manually resolved Promise.

import { AgentName, type Tab } from '@shared/domain/project'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RetireThreadDialog } from './retire-thread-dialog'

const PANE = '00000000-0000-4000-8000-000000000101'
const OTHER_PANE = '00000000-0000-4000-8000-000000000102'
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
    backend: 'dia-claude-code',
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

describe('RetireThreadDialog', () => {
  it('names the worktree it deletes and the branch and transcripts that stay', () => {
    installBridge(Promise.resolve(null))
    render(
      <RetireThreadDialog
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
      <RetireThreadDialog
        tab={{ ...tab(), archived: true }}
        retirement="delete"
        onClose={() => undefined}
      />
    )

    expect(dialogText()).not.toContain('dia stops this agent')
  })

  it('closes before the host has finished deleting the tab it was opened for', () => {
    const bridge = installBridge(new Promise<string | null>(() => undefined))
    const onClose = vi.fn()
    render(
      <RetireThreadDialog tab={tab({ paneId: OTHER_PANE })} retirement="delete" onClose={onClose} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect([
      onClose.mock.calls.length,
      bridge.deleteTab.mock.calls,
      bridge.archiveTab.mock.calls
    ]).toEqual([1, [[OTHER_PANE]], []])
  })

  it('archives through archiveTab when opened to archive', async () => {
    const bridge = installBridge(Promise.resolve(null))
    render(
      <RetireThreadDialog
        tab={tab({ worktree: WORKTREE })}
        retirement="archive"
        onClose={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(bridge.archiveTab.mock.calls).toEqual([[PANE]]))
  })
})

// @vitest-environment jsdom

import type { BranchList } from '@dia-plugin/dia-git/calls'
import type { WorktreeStart } from '@shared/domain/project'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceMenu } from './workspace-menu'

const list: BranchList = {
  head: { _tag: 'OnBranch', branch: 'topic' },
  defaultBase: 'origin/main',
  branches: [
    { name: 'topic', remote: null },
    { name: 'origin/main', remote: 'origin' }
  ]
}

vi.mock('@dia/renderer-plugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dia/renderer-plugin')>()),
  callHost: () => Effect.succeed(list)
}))

afterEach(cleanup)

const renderMenu = (worktree: WorktreeStart | null) => {
  const onWorktreeChange = vi.fn()
  render(
    <WorkspaceMenu
      directory="/repo"
      worktree={worktree}
      onWorktreeChange={onWorktreeChange}
      busyThread={null}
    />
  )
  return onWorktreeChange
}

describe('WorkspaceMenu default base', () => {
  it("names the repository's default base on a worktree choice with no base", async () => {
    const onWorktreeChange = renderMenu({ base: null })

    await waitFor(() => expect(onWorktreeChange).toHaveBeenCalledWith({ base: 'origin/main' }))
  })

  it('keeps a base the draft already chose', async () => {
    const onWorktreeChange = renderMenu({ base: 'topic' })

    await waitFor(() => expect(document.body.textContent).toContain('Worktree from topic'))
    expect(onWorktreeChange).not.toHaveBeenCalled()
  })

  it('leaves the checkout choice alone', async () => {
    const onWorktreeChange = renderMenu(null)

    await waitFor(() => expect(document.body.textContent).toContain('topic'))
    expect(onWorktreeChange).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { AgentName, type Tab } from './project'
import { AgentItem, removalItemsOf, WorktreeItem } from './project-removal'

const paneId = '10000000-0000-4000-8000-000000000001'
const name = AgentName.make('heron')
const worktree = { path: 'F:\\wt\\heron', branch: 'dia/heron', sourceRepo: 'F:\\Dev\\repo1' }

const worktreeTab = (archived: boolean): Tab => ({
  name,
  config: {
    paneId,
    cwd: worktree.path,
    model: 'claude-sonnet-5-5',
    thinkingLevel: 'adaptive',
    permissionMode: 'default',
    worktree
  },
  archived
})

describe('removalItemsOf', () => {
  it('lists the agent, then its worktree, for a tab that is not archived', () => {
    expect(removalItemsOf(worktreeTab(false))).toEqual([
      AgentItem.make({ paneId, name }),
      WorktreeItem.make({ path: worktree.path })
    ])
  })

  it('lists only the agent for an archived tab, whose worktree archiving removed', () => {
    expect(removalItemsOf(worktreeTab(true))).toEqual([AgentItem.make({ paneId, name })])
  })
})

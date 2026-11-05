// @vitest-environment jsdom

import type { PaneChatState } from '@dia/renderer-plugin'
import { AgentName, ProjectId, type Workspace } from '@shared/domain/project'
import { cleanup, render, screen } from '@testing-library/react'
import { AsyncResult, Atom } from 'effect/reactivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Chat } from './chat'

const PANE = '00000000-0000-4000-8000-000000000101'

const state = vi.hoisted(() => ({
  workspace: undefined as Workspace | undefined,
  messages: [] as PaneChatState['messages']
}))

vi.mock('@dia/renderer-plugin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dia/renderer-plugin')>()
  return {
    ...original,
    useView: () => ({ _tag: 'TabView', paneId: PANE }),
    useWorkspace: () => state.workspace,
    useTabOpenedFromNewAgent: () => false,
    paneChatAtom: () =>
      Atom.make(AsyncResult.success({ ...original.emptyPaneChatState, messages: state.messages }))
  }
})

const archivedWorkspace = (): Workspace => ({
  projects: [
    {
      project: {
        projectId: ProjectId.make('00000000-0000-4000-8000-000000000001'),
        directory: '/repo',
        directoryKey: '/repo',
        displayName: 'repo',
        isGitRepo: true
      },
      tabs: [
        {
          name: AgentName.make('old-heron'),
          config: {
            paneId: PANE,
            cwd: '/worktrees/old-heron',
            model: 'm',
            thinkingLevel: 'adaptive',
            permissionMode: 'default'
          },
          archived: true
        }
      ]
    }
  ],
  visibleTab: PANE
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
  state.workspace = archivedWorkspace()
  state.messages = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'Fix the anchor' }] }
  ]
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Chat for an archived tab', () => {
  it('shows the transcript with no composer and says it is read-only', () => {
    render(<Chat />)

    expect([
      document.body.textContent?.includes('Fix the anchor'),
      document.body.textContent?.includes('This agent is archived. Its transcript is read-only.'),
      screen.queryByRole('textbox')
    ]).toEqual([true, true, null])
  })

  it('says the transcript is empty when the agent has no stored conversation', () => {
    state.messages = []
    render(<Chat />)

    expect(document.body.textContent).toContain('This agent is archived. Its transcript is empty.')
  })
})

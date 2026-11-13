import {
  type AgentStatus,
  AgentSummary,
  NoActivity,
  StatusFailed,
  StatusFinished,
  StatusNeedsInput,
  StatusWorking
} from '@shared/domain/agent-summary'
import type { AgentNotification } from '@shared/domain/notification'
import { AgentName, ProjectId, type Workspace } from '@shared/domain/project'
import { describe, expect, it } from 'vitest'
import {
  attentionChanged,
  INITIAL_RULE_STATE,
  type RuleState,
  type RuleStep,
  summaryChanged,
  workspaceChanged
} from './notification-rule'

const BUILD = '00000000-0000-4000-8000-000000000001'
const DOCS = '00000000-0000-4000-8000-000000000002'
const UNKNOWN = '00000000-0000-4000-8000-000000000009'

const tab = (paneId: string, name: string) => ({
  name: AgentName.make(name),
  config: {
    paneId,
    cwd: '/repo',
    model: 'm',
    thinkingLevel: 'adaptive' as const,
    permissionMode: 'default' as const
  },
  archived: false
})

const workspace = (visibleTab: string | null): Workspace => ({
  projects: [
    {
      project: {
        projectId: ProjectId.make('00000000-0000-4000-8000-0000000000aa'),
        directory: '/repo',
        directoryKey: '/repo',
        displayName: 'dia',
        isGitRepo: true
      },
      tabs: [tab(BUILD, 'brave-otter'), tab(DOCS, 'calm-heron')]
    }
  ],
  visibleTab
})

const summary = (paneId: string, status: AgentStatus) =>
  summaryChanged(AgentSummary.make({ paneId, status, activity: NoActivity.make({}) }))

const PERMISSION = StatusNeedsInput.make({ reason: 'Allow Bash npm test?' })

const run = (
  steps: ReadonlyArray<RuleStep>,
  start: RuleState = INITIAL_RULE_STATE
): ReadonlyArray<AgentNotification> => {
  let state = start
  const shown: Array<AgentNotification> = []
  for (const step of steps) {
    const [next, notifications] = step(state)
    state = next
    shown.push(...notifications)
  }
  return shown
}

describe('notification rule', () => {
  it('notifies once for a permission request from an agent whose tab is not visible, naming agent, project and reason', () => {
    const shown = run([workspaceChanged(workspace(DOCS)), summary(BUILD, PERMISSION)])

    expect(shown).toEqual([
      { paneId: BUILD, title: 'brave-otter in dia', body: 'Needs input: Allow Bash npm test?' }
    ])
  })

  it('notifies for a failure from an agent whose tab is not visible', () => {
    const shown = run([
      workspaceChanged(workspace(DOCS)),
      summary(BUILD, StatusFailed.make({ reason: 'Process exited' }))
    ])

    expect(shown.map((notification) => notification.body)).toEqual(['Failed: Process exited'])
  })

  it('does not notify for the visible agent while the window is attended', () => {
    const shown = run([workspaceChanged(workspace(BUILD)), summary(BUILD, PERMISSION)])

    expect(shown).toEqual([])
  })

  it('notifies for the visible agent while the window is not attended', () => {
    const shown = run([
      workspaceChanged(workspace(BUILD)),
      attentionChanged(false),
      summary(BUILD, PERMISSION)
    ])

    expect(shown.map((notification) => notification.paneId)).toEqual([BUILD])
  })

  it('does not notify for the visible agent once the window is attended again', () => {
    const shown = run([
      workspaceChanged(workspace(BUILD)),
      attentionChanged(false),
      attentionChanged(true),
      summary(BUILD, PERMISSION)
    ])

    expect(shown).toEqual([])
  })

  it('does not notify again when the same status is derived again', () => {
    const shown = run([
      workspaceChanged(workspace(DOCS)),
      summary(BUILD, PERMISSION),
      summary(BUILD, StatusNeedsInput.make({ reason: 'Allow Bash npm test?' }))
    ])

    expect(shown).toHaveLength(1)
  })

  it('notifies for each new request after the agent worked in between', () => {
    const shown = run([
      workspaceChanged(workspace(DOCS)),
      summary(BUILD, PERMISSION),
      summary(BUILD, StatusWorking.make({})),
      summary(BUILD, PERMISSION)
    ])

    expect(shown).toHaveLength(2)
  })

  it('notifies when an agent that needs input fails', () => {
    const shown = run([
      workspaceChanged(workspace(DOCS)),
      summary(BUILD, PERMISSION),
      summary(BUILD, StatusFailed.make({ reason: 'Process exited' }))
    ])

    expect(shown.map((notification) => notification.body)).toEqual([
      'Needs input: Allow Bash npm test?',
      'Failed: Process exited'
    ])
  })

  it('does not notify for a finished turn in a tab that is not visible', () => {
    const shown = run([
      workspaceChanged(workspace(DOCS)),
      summary(BUILD, StatusWorking.make({})),
      summary(BUILD, StatusFinished.make({}))
    ])

    expect(shown).toEqual([])
  })

  it('does not notify for an agent with no tab in the workspace', () => {
    const shown = run([workspaceChanged(workspace(DOCS)), summary(UNKNOWN, PERMISSION)])

    expect(shown).toEqual([])
  })

  it('does not notify before the workspace is known', () => {
    const shown = run([summary(BUILD, PERMISSION)])

    expect(shown).toEqual([])
  })
})

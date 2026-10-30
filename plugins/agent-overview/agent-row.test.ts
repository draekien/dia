import { formatResetTime } from '@dia/renderer-plugin'
import {
  type Activity,
  type AgentStatus,
  NoActivity,
  StatusFailed,
  StatusNeedsInput,
  StatusParked,
  StatusWorking,
  Todo,
  ToolUse
} from '@shared/domain/agent-summary'
import { describe, expect, it } from 'vitest'
import { secondLine } from './agent-row'

const summary = (status: AgentStatus, activity: Activity) => ({
  paneId: '00000000-0000-4000-8000-000000000101',
  status,
  activity
})

const WORKING = StatusWorking.make({})
const EDITING = ToolUse.make({ tool: 'Edit', target: 'src/main/index.ts' })

describe('secondLine', () => {
  it('shows the reason of an agent that needs input instead of its activity', () => {
    expect(secondLine(summary(StatusNeedsInput.make({ reason: 'Allow Bash?' }), EDITING))).toEqual({
      text: 'Allow Bash?',
      mono: false
    })
  })

  it('shows the reason of a failed agent instead of its activity', () => {
    expect(secondLine(summary(StatusFailed.make({ reason: 'exit 1' }), EDITING)).text).toBe(
      'exit 1'
    )
  })

  it('shows a tool call as the tool and its target in mono', () => {
    expect(secondLine(summary(WORKING, EDITING))).toEqual({
      text: 'Edit src/main/index.ts',
      mono: true
    })
  })

  it('shows only the tool name for a tool call without a target', () => {
    expect(
      secondLine(summary(WORKING, ToolUse.make({ tool: 'TodoWrite', target: null }))).text
    ).toBe('TodoWrite')
  })

  it('shows the in-progress todo in the proportional font', () => {
    expect(secondLine(summary(WORKING, Todo.make({ text: 'Write the rail' })))).toEqual({
      text: 'Write the rail',
      mono: false
    })
  })

  it('says there is no activity yet for an agent that has done nothing', () => {
    expect(secondLine(summary(WORKING, NoActivity.make({}))).text).toBe('No activity yet')
  })
})

describe('secondLine — turn status', () => {
  const RETRYING = 'Retrying (attempt 2 of 10) in 4s · 529'

  it('shows the turn’s named state in sans instead of the activity line', () => {
    expect(secondLine({ ...summary(WORKING, EDITING), turnStatus: RETRYING })).toEqual({
      text: RETRYING,
      mono: false
    })
  })

  it('keeps the reason of an agent that needs input over the turn’s named state', () => {
    const needsInput = StatusNeedsInput.make({ reason: 'Allow Bash?' })
    expect(secondLine({ ...summary(needsInput, EDITING), turnStatus: RETRYING }).text).toBe(
      'Allow Bash?'
    )
  })

  it('shows when dia resumes a parked agent instead of its activity', () => {
    const resumesAt = 1_700_000_000_000
    const nowMs = resumesAt - 60_000
    const parked = StatusParked.make({ until: resumesAt, resumedBy: 'dia' })
    expect(secondLine(summary(parked, EDITING), nowMs)).toEqual({
      text: `Resumes ${formatResetTime(resumesAt, nowMs)}`,
      mono: false
    })
  })

  it('shows when the limit of an agent the user resumes resets', () => {
    const resetsAt = 1_700_000_000_000
    const nowMs = resetsAt - 60_000
    const parked = StatusParked.make({ until: resetsAt, resumedBy: 'user' })
    expect(secondLine(summary(parked, EDITING), nowMs).text).toBe(
      `Resets ${formatResetTime(resetsAt, nowMs)}`
    )
  })
})

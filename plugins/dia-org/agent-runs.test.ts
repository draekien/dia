import { AGENT_NAME_MAX_LENGTH, AgentName, ProjectId } from '@dia/plugin'
import { AgentDefinitionName } from '@dia-plugin/dia-agent-definitions/registry'
import { IssueId, type IssueStatus, ObjectiveId, WorkTitle } from '@dia-plugin/dia-issues/domain'
import { describe, expect, it } from 'vitest'
import { type AgentRunSources, agentRunsOf, issueRunTabName } from './agent-runs'
import { HireId, JobTitleId } from './domain'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-000000000001')
const OBJECTIVE = ObjectiveId.make('00000000-0000-4000-8000-000000000002')
const ENGINEER = JobTitleId.make('00000000-0000-4000-8000-000000000003')
const ADA = HireId.make('00000000-0000-4000-8000-000000000004')
const UNNAMED = HireId.make('00000000-0000-4000-8000-000000000005')
const issueId = (n: number) => IssueId.make(`00000000-0000-4000-8000-0000000001${n}0`)

const issue = (n: number, title: string, status: IssueStatus) => ({
  id: issueId(n),
  objectiveId: OBJECTIVE,
  title: WorkTitle.make(title),
  status
})

const sources = (patch: Partial<AgentRunSources> = {}): AgentRunSources => ({
  runs: [{ issueId: issueId(1), hireId: ADA, runId: 'run-1' }],
  snapshot: {
    issues: [issue(1, 'Add a login page', 'implementing')],
    objectives: [{ id: OBJECTIVE, projectId: PROJECT }]
  },
  projects: [{ projectId: PROJECT, displayName: 'dia' }],
  hires: [
    { id: ADA, name: AgentName.make('Ada'), jobTitleId: ENGINEER },
    { id: UNNAMED, name: null, jobTitleId: ENGINEER }
  ],
  jobTitles: [{ id: ENGINEER, name: AgentDefinitionName.make('Software engineer') }],
  ...patch
})

describe('agentRunsOf', () => {
  it('names the run, its issue, its project, its hire and the hire’s job title', () => {
    expect(agentRunsOf(sources())).toEqual([
      {
        runId: 'run-1',
        issueTitle: 'Add a login page',
        projectName: 'dia',
        hireName: 'Ada',
        jobTitle: 'Software engineer'
      }
    ])
  })

  it.each<IssueStatus>(['triage', 'todo', 'done', 'canceled'])(
    'leaves out the run of an issue in %s',
    (status) => {
      const snapshot = { ...sources().snapshot, issues: [issue(1, 'Add a login page', status)] }

      expect(agentRunsOf(sources({ snapshot }))).toEqual([])
    }
  )

  it('leaves out a run whose hire was dismissed', () => {
    expect(agentRunsOf(sources({ hires: [] }))).toEqual([])
  })

  it('gives an unnamed hire a null name', () => {
    const runs = [{ issueId: issueId(1), hireId: UNNAMED, runId: 'run-1' }]

    expect(agentRunsOf(sources({ runs }))[0]?.hireName).toBeNull()
  })

  it('names a project that is no longer registered Removed project', () => {
    expect(agentRunsOf(sources({ projects: [] }))[0]?.projectName).toBe('Removed project')
  })

  it('orders the runs by issue title', () => {
    const runs = [
      { issueId: issueId(1), hireId: ADA, runId: 'run-1' },
      { issueId: issueId(2), hireId: ADA, runId: 'run-2' }
    ]
    const snapshot = {
      ...sources().snapshot,
      issues: [issue(1, 'Write the docs', 'designing'), issue(2, 'Add a login page', 'in_review')]
    }

    expect(agentRunsOf(sources({ runs, snapshot })).map((run) => run.runId)).toEqual([
      'run-2',
      'run-1'
    ])
  })
})

describe('issueRunTabName', () => {
  it('joins the assignee and the issue title', () => {
    expect(issueRunTabName('Ada', 'Add a login page')).toBe('Ada · Add a login page')
  })

  it('shortens a long issue title with an ellipsis to fit the tab name limit', () => {
    const name = issueRunTabName('Ada', 'x'.repeat(100))

    expect([name.length, name.startsWith('Ada · '), name.endsWith('…')]).toEqual([
      AGENT_NAME_MAX_LENGTH,
      true,
      true
    ])
  })

  it('keeps a name of exactly the limit whole', () => {
    const title = 'x'.repeat(AGENT_NAME_MAX_LENGTH - 'Ada · '.length)

    expect(issueRunTabName('Ada', title)).toBe(`Ada · ${title}`)
  })
})

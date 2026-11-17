// @vitest-environment jsdom
import { SidebarProvider, TooltipProvider } from '@dia/renderer-plugin'
import {
  NoActivity,
  type RunSummary,
  type RunSummaryStatus,
  StatusFailed,
  StatusIdle,
  StatusNeedsInput,
  StatusWorking
} from '@shared/domain/run-summary'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Option } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentsSection, agentLine, agentRows } from './agents-section'
import { AgentRun } from './calls'

const state = vi.hoisted(() => ({
  summaries: new Map<string, RunSummary>(),
  selectTab: (_paneId: string) => {}
}))

vi.mock('@dia/renderer-plugin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dia/renderer-plugin')>()
  return {
    ...original,
    actions: { ...original.actions, selectTab: (paneId: string) => state.selectTab(paneId) },
    useRunSummaries: () => state.summaries,
    useView: () => undefined
  }
})

const run = (runId: string, issueTitle: string) =>
  AgentRun.make({ runId, issueTitle, projectName: 'dia', assignee: 'Ada' })

const summary = (runId: string, status: RunSummaryStatus): RunSummary => ({
  paneId: runId,
  status,
  activity: NoActivity.make({})
})

const summariesOf = (...entries: ReadonlyArray<RunSummary>) =>
  new Map(entries.map((entry) => [entry.paneId, entry]))

beforeEach(() => {
  state.selectTab = vi.fn()
  state.summaries = new Map()
})

afterEach(cleanup)

describe('agentRows', () => {
  it('puts the most urgent run first and keeps title order within a status', () => {
    const runs = [run('a', 'Add a login page'), run('b', 'Fix the build'), run('c', 'Write docs')]
    const summaries = summariesOf(
      summary('a', StatusWorking.make({})),
      summary('b', StatusNeedsInput.make({ reason: 'Approve plan' })),
      summary('c', StatusWorking.make({}))
    )

    expect(agentRows(runs, summaries).map((row) => row.run.runId)).toEqual(['b', 'a', 'c'])
  })

  it('leaves out a run whose tab has no summary', () => {
    const summaries = summariesOf(summary('a', StatusIdle.make({})))

    expect(agentRows([run('a', 'One'), run('b', 'Two')], summaries).length).toBe(1)
  })
})

describe('agentLine', () => {
  it('names the hire and the project while the run works', () => {
    expect(agentLine({ run: run('a', 'One'), summary: summary('a', StatusWorking.make({})) })).toBe(
      'Ada, dia'
    )
  })

  it('gives the reason while the run failed', () => {
    const row = {
      run: run('a', 'One'),
      summary: summary('a', StatusFailed.make({ reason: 'Crashed' }))
    }

    expect(agentLine(row)).toBe('Crashed')
  })
})

describe('AgentsSection', () => {
  const show = (runs: ReadonlyArray<AgentRun>) =>
    render(
      <TooltipProvider>
        <SidebarProvider open onOpenChange={() => {}}>
          <AgentsSection
            runsAtom={Atom.make(AsyncResult.success(Option.some(runs)))}
            iconMode={false}
          />
        </SidebarProvider>
      </TooltipProvider>
    )

  it('shows the run’s tab when its row is clicked', () => {
    state.summaries = summariesOf(summary('a', StatusWorking.make({})))
    show([run('a', 'Add a login page')])

    fireEvent.click(screen.getByRole('button', { name: /^Add a login page, Working/ }))

    expect(state.selectTab).toHaveBeenCalledWith('a')
  })

  it('draws nothing while no run has a tab', () => {
    show([run('a', 'Add a login page')])

    expect(screen.queryByText('Agents')).toBeNull()
  })
})

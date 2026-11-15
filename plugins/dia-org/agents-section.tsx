import {
  actions,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  StatusIndicator,
  statusLabel,
  statusRank,
  useRunSummaries,
  useView
} from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import type { RunSummary } from '@shared/domain/run-summary'
import { Option } from 'effect'
import { AsyncResult, type Atom } from 'effect/reactivity'
import type { AgentRun } from './calls'

/** The atom following the org's `WatchAgentRuns` stream; `None` while the org host entry is not serving. */
export type AgentRunsAtom = Atom.Atom<
  AsyncResult.AsyncResult<Option.Option<ReadonlyArray<AgentRun>>, unknown>
>

/** One row of the Agents section: an agent run and its tab's summary. */
export interface AgentRow {
  readonly run: AgentRun
  readonly summary: RunSummary
}

/**
 * The Agents section's rows for `runs` (ordered by issue title) and the tabs' `summaries`: one per
 * run whose tab has a summary, most urgent status first, keeping title order within a status.
 */
export const agentRows = (
  runs: ReadonlyArray<AgentRun>,
  summaries: ReadonlyMap<string, RunSummary>
): ReadonlyArray<AgentRow> =>
  runs
    .flatMap((run) => {
      const summary = summaries.get(run.runId)
      return summary === undefined ? [] : [{ run, summary }]
    })
    .map((row, order) => ({ row, order }))
    .sort(
      (a, b) =>
        statusRank(a.row.summary.status) - statusRank(b.row.summary.status) || a.order - b.order
    )
    .map(({ row }) => row)

/**
 * The second line of an agent row: the reason while the run needs input or failed, otherwise who
 * works on the issue and in which project.
 */
export const agentLine = ({ run, summary }: AgentRow): string => {
  switch (summary.status._tag) {
    case 'StatusNeedsInput':
    case 'StatusFailed':
      return summary.status.reason
    default:
      return `${run.hireName ?? run.jobTitle} · ${run.projectName}`
  }
}

function AgentRunRow({ row, selected }: { readonly row: AgentRow; readonly selected: boolean }) {
  const status = statusLabel(row.summary.status)
  const line = agentLine(row)
  const label = `${row.run.issueTitle}, ${status}. ${line}`
  const assignee = row.run.hireName ?? row.run.jobTitle
  const tooltip = `${assignee} · ${row.run.issueTitle} · ${row.run.projectName} · ${status}`
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={selected}
        tooltip={tooltip}
        aria-label={label}
        aria-current={selected ? 'page' : undefined}
        onClick={() => actions.selectTab(row.run.runId)}
        className="cursor-default group-data-[collapsible=icon]:justify-center"
      >
        <StatusIndicator status={row.summary.status} />
        <span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
          <span className="truncate text-sm text-ink">{row.run.issueTitle}</span>
          <span className="truncate text-xs text-ink-muted">{line}</span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * The sidebar's Agents section: one row per issue run a hired agent works on, most urgent first.
 * Clicking a row shows the run's tab. Draws nothing while no run has a tab.
 */
export function AgentsSection({
  runsAtom,
  iconMode
}: {
  readonly runsAtom: AgentRunsAtom
  readonly iconMode: boolean
}) {
  const result = useAtomValue(runsAtom)
  const summaries = useRunSummaries()
  const view = useView()
  const runs = AsyncResult.isSuccess(result) ? Option.getOrElse(result.value, () => []) : []
  const rows = agentRows(runs, summaries)
  if (rows.length === 0) return null
  return (
    <>
      {iconMode && <SidebarSeparator />}
      <SidebarGroup className="pt-0">
        <SidebarGroupLabel>Agents</SidebarGroupLabel>
        <SidebarMenu>
          {rows.map((row) => (
            <AgentRunRow
              key={row.run.runId}
              row={row}
              selected={view?._tag === 'TabView' && view.paneId === row.run.runId}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </>
  )
}

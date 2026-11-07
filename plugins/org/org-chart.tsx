import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle
} from '@dia/renderer-plugin'
import { UserIcon } from 'lucide-react'
import type { JobTitle } from './domain'
import { agentName, jobTitleName, type OrgScreen } from './org-actions'
import { type OrgNode, orgTree } from './org-tree'
import { HiredAgentsView } from './org-view'

/** The empty state of the Org chart and Hired agents pages; `Hire…` opens the Hire dialog. */
export function NoHires({ openHire }: Pick<OrgScreen, 'openHire'>) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No agents are hired</EmptyTitle>
        <EmptyDescription>Hired agents and who they report to show here.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" onClick={() => openHire(null)}>
          Hire…
        </Button>
      </EmptyContent>
    </Empty>
  )
}

function Reports({
  nodes,
  jobTitles,
  show
}: {
  readonly nodes: ReadonlyArray<OrgNode>
  readonly jobTitles: ReadonlyArray<JobTitle>
  readonly show: OrgScreen['show']
}) {
  if (nodes.length === 0) return null
  return (
    <ul className="ml-3 flex flex-col gap-px border-l pl-3">
      {nodes.map((node) => (
        <li key={node.agent.id} className="flex flex-col gap-px">
          <button
            type="button"
            onClick={() => show(HiredAgentsView.make({ hireId: node.agent.id }))}
            className="flex min-w-0 items-baseline gap-2 self-start rounded-md px-2 py-1 text-left text-sm text-ink outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="truncate font-medium">{agentName(node.agent, jobTitles)}</span>
            <span className="truncate text-xs text-ink-muted">
              {jobTitleName(node.agent, jobTitles)}
            </span>
          </button>
          <Reports nodes={node.reports} jobTitles={jobTitles} show={show} />
        </li>
      ))}
    </ul>
  )
}

/**
 * The Org chart: the user at the root and every hired agent under the agent it reports to, each
 * showing its name and job title. Selecting an agent shows it on the Hired agents page.
 */
export function OrgChart({ snapshot, show, openHire }: Omit<OrgScreen, 'call'>) {
  if (snapshot.hiredAgents.length === 0) return <NoHires openHire={openHire} />
  return (
    <section aria-label="Org chart" className="flex flex-col gap-px">
      <span className="flex items-center gap-2 px-2 py-1 text-sm font-medium text-ink">
        <UserIcon className="size-4 text-ink-muted" aria-hidden="true" />
        You
      </span>
      <Reports nodes={orgTree(snapshot.hiredAgents)} jobTitles={snapshot.jobTitles} show={show} />
    </section>
  )
}

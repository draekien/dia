// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
import { Button, Input, SettingsRow, toast } from '@dia/renderer-plugin'
import { cva } from 'class-variance-authority'
import { Result } from 'effect'
import { Loader2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { AssignIssue, CreateIssue, FinishIssue, type OrgSnapshot } from './calls'
import {
  type HireId,
  type Issue,
  IssueId,
  type IssueStatus,
  isStarted,
  type Objective,
  PRIORITY_LABELS
} from './domain'
import { agentName, commonFailureText, newId, type OrgCall, readWorkTitle } from './org-actions'
import { AssigneeSelect } from './org-fields'

const STATUS_LABELS: Record<IssueStatus, string> = {
  triage: 'Triage',
  todo: 'Todo',
  understanding: 'Understanding',
  designing: 'Designing',
  implementing: 'Implementing',
  testing: 'Testing',
  verifying: 'Verifying',
  in_review: 'In Review',
  done: 'Done',
  canceled: 'Canceled'
}

const KIND_LABELS: Record<Issue['kind'], string | null> = {
  work: null,
  retro: 'Retro',
  planning: 'Planning'
}

const STARTED_STATUS_STYLE = 'font-medium text-ink'

/**
 * The text style of an issue's status label, by `status`: a started issue reads in full ink, a
 * `canceled` one muted with a line through it, the rest muted.
 */
export const issueStatusVariants = cva('w-24 shrink-0 text-xs', {
  variants: {
    status: {
      triage: 'text-ink-muted',
      todo: 'text-ink-muted',
      understanding: STARTED_STATUS_STYLE,
      designing: STARTED_STATUS_STYLE,
      implementing: STARTED_STATUS_STYLE,
      testing: STARTED_STATUS_STYLE,
      verifying: STARTED_STATUS_STYLE,
      in_review: STARTED_STATUS_STYLE,
      done: 'text-ink-muted',
      canceled: 'text-ink-muted line-through'
    }
  }
})

interface IssueNode {
  readonly issue: Issue
  readonly children: ReadonlyArray<IssueNode>
}

const issueTree = (
  issues: ReadonlyArray<Issue>,
  parent: IssueId | null
): ReadonlyArray<IssueNode> =>
  issues
    .filter((issue) => issue.parentIssueId === parent)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((issue) => ({ issue, children: issueTree(issues, issue.id) }))

const issueFailureText = (failure: { readonly _tag: string }): string => {
  switch (failure._tag) {
    case 'IssueNotFound':
      return 'This issue was removed'
    case 'IssueNotAssignable':
      return 'This issue has already started'
    case 'IssueNotStarted':
      return 'This issue has not started'
    case 'IssueNotInTriage':
      return 'This issue is no longer in Triage'
    case 'ObjectiveNotFound':
      return 'This objective was removed'
    default:
      return commonFailureText(failure) ?? failure._tag
  }
}

const toastIssueFailure = (title: string, failure: { readonly _tag: string }) => {
  toast.add({ title, description: issueFailureText(failure), type: 'error' })
}

function IssueRow({
  issue,
  snapshot,
  call
}: {
  readonly issue: Issue
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
}) {
  const [finishing, setFinishing] = useState(false)

  const assign = async (hireId: HireId | null) => {
    if (hireId === issue.assignee) return
    const result = await call(AssignIssue, { issueId: issue.id, hireId }, issue.id)
    if (Result.isFailure(result)) {
      toastIssueFailure(`Could not assign ${issue.title}`, result.failure)
    }
  }

  const finish = async () => {
    setFinishing(true)
    const result = await call(FinishIssue, { issueId: issue.id }, issue.id).finally(() =>
      setFinishing(false)
    )
    if (Result.isFailure(result)) {
      toastIssueFailure(`Could not finish ${issue.title}`, result.failure)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-3 py-1">
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{issue.title}</span>
      {KIND_LABELS[issue.kind] === null ? null : (
        <span className="text-xs text-ink-muted">{KIND_LABELS[issue.kind]}</span>
      )}
      <span className={issueStatusVariants({ status: issue.status })}>
        {STATUS_LABELS[issue.status]}
      </span>
      <AssigneeSelect
        label={`Assignee of ${issue.title}`}
        none="Unassigned"
        value={issue.assignee}
        hiredAgents={snapshot.hiredAgents}
        jobTitles={snapshot.jobTitles}
        disabled={issue.status !== 'triage' && issue.status !== 'todo'}
        className="h-8 w-40"
        onChange={(next) => void assign(next)}
      />
      <span className="flex w-16 shrink-0 justify-end">
        {isStarted(issue.status) ? (
          <Button size="xs" variant="outline" disabled={finishing} onClick={() => void finish()}>
            {finishing ? (
              <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
            ) : null}
            Finish
          </Button>
        ) : null}
      </span>
    </div>
  )
}

function IssueList({
  nodes,
  nested,
  snapshot,
  call
}: {
  readonly nodes: ReadonlyArray<IssueNode>
  readonly nested: boolean
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
}) {
  if (nodes.length === 0) return null
  return (
    <ul className={nested ? 'ml-3 flex flex-col border-l pl-3' : 'flex flex-col'}>
      {nodes.map((node) => (
        <li key={node.issue.id} aria-label={node.issue.title} className="flex flex-col">
          <IssueRow issue={node.issue} snapshot={snapshot} call={call} />
          <IssueList nodes={node.children} nested snapshot={snapshot} call={call} />
        </li>
      ))}
    </ul>
  )
}

function AddIssue({
  objective,
  snapshot,
  call
}: {
  readonly objective: Objective
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
}) {
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState<HireId | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const readTitle = readWorkTitle(title)
    if (Result.isFailure(readTitle)) return setError(readTitle.failure)
    setBusy(true)
    const id = IssueId.make(newId())
    const result = await call(
      CreateIssue,
      {
        issue: {
          id,
          objectiveId: objective.id,
          parentIssueId: null,
          title: readTitle.success,
          description: '',
          assignee
        }
      },
      id
    ).finally(() => setBusy(false))
    if (Result.isFailure(result)) return setError(issueFailureText(result.failure))
    setTitle('')
    setAssignee(null)
  }

  return (
    <form className="flex flex-col gap-1.5" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={title}
          aria-label="Issue title"
          placeholder="New issue"
          autoComplete="off"
          aria-invalid={error !== undefined}
          className="h-8 min-w-48 flex-1"
          onChange={(event) => {
            setTitle(event.target.value)
            setError(undefined)
          }}
        />
        <AssigneeSelect
          label="Assignee of the new issue"
          none="Unassigned"
          value={assignee}
          hiredAgents={snapshot.hiredAgents}
          jobTitles={snapshot.jobTitles}
          className="h-8 w-40"
          onChange={setAssignee}
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          {busy ? (
            <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
          ) : null}
          Add issue
        </Button>
      </div>
      {error === undefined ? null : (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </form>
  )
}

/**
 * The detail of `objective`: its title, project (`projectName`), priority, state, assignee and
 * description, then the tree of its issues among `issues`, each sub-issue under its parent and each
 * retro issue under the issue it reviews. A `triage` or `todo` issue's assignee can change and a
 * started issue can be finished; an open objective takes new issues. Calls go through `call`.
 */
export function ObjectiveScreen({
  objective,
  projectName,
  issues,
  snapshot,
  call
}: {
  readonly objective: Objective
  readonly projectName: string
  readonly issues: ReadonlyArray<Issue>
  readonly snapshot: OrgSnapshot
  readonly call: OrgCall
}) {
  const own = issues.filter((issue) => issue.objectiveId === objective.id)
  const assignee = snapshot.hiredAgents.find((agent) => agent.id === objective.assignee)

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h3 className="text-base font-semibold text-ink">{objective.title}</h3>
      <dl className="flex flex-col gap-4">
        <SettingsRow label="Project">{projectName}</SettingsRow>
        <SettingsRow label="Priority">{PRIORITY_LABELS[objective.priority]}</SettingsRow>
        <SettingsRow label="State">{objective.state === 'open' ? 'Open' : 'Completed'}</SettingsRow>
        <SettingsRow label="Assignee">
          {assignee === undefined ? 'Unassigned' : agentName(assignee, snapshot.jobTitles)}
        </SettingsRow>
        <SettingsRow label="Description">
          {objective.description === '' ? (
            <span className="text-ink-muted">No description</span>
          ) : (
            <p className="max-w-prose whitespace-pre-wrap">{objective.description}</p>
          )}
        </SettingsRow>
      </dl>
      <section className="flex flex-col gap-3 border-t pt-5" aria-labelledby="org-objective-issues">
        <h4 id="org-objective-issues" className="text-sm font-medium text-ink">
          Issues
        </h4>
        {own.length === 0 ? (
          <p className="text-sm text-ink-muted">No issues yet.</p>
        ) : (
          <IssueList nodes={issueTree(own, null)} nested={false} snapshot={snapshot} call={call} />
        )}
        {objective.state === 'open' ? (
          <AddIssue objective={objective} snapshot={snapshot} call={call} />
        ) : null}
      </section>
    </div>
  )
}

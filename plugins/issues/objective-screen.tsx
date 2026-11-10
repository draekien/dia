// @effect-diagnostics asyncFunction:off -- React callbacks await IssuesCall's Promise; components hold no Effect runtime.
import {
  AvatarFallback,
  Button,
  Entity,
  EntityMedia,
  EntityName,
  Input,
  SettingsRow,
  Status,
  StatusMedia,
  StatusName,
  toast
} from '@dia/renderer-plugin'
import { cva } from 'class-variance-authority'
import { Result } from 'effect'
import { isReadonlyArrayNonEmpty } from 'effect/Array'
import { Loader2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { AssigneeSelect } from './assignee-select'
import { AssignIssue, CreateIssue, FinishIssue, type IssuesView, TriageIssues } from './calls'
import {
  type AssigneeGroup,
  type AssigneeRef,
  type Issue,
  type IssueComment,
  IssueId,
  type IssueStatus,
  isAssignable,
  isStarted,
  type Objective,
  PRIORITY_LABELS,
  sameAssignee,
  type TriageDecision
} from './domain'
import { assigneeLabel, failureText, type IssuesCall, newId, readWorkTitle } from './issue-actions'

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

const statusFill = (status: IssueStatus): 'none' | 'half' | 'full' =>
  status === 'done' ? 'full' : isStarted(status) ? 'half' : 'none'

const KIND_LABELS: Record<Issue['kind'], string | null> = {
  work: null,
  retro: 'Retro',
  planning: 'Planning'
}

const issueTitleVariants = cva('min-w-0 truncate text-sm', {
  variants: {
    canceled: {
      true: 'text-ink-muted line-through',
      false: 'text-ink'
    }
  }
})

interface IssueNode {
  readonly issue: Issue
  readonly children: ReadonlyArray<IssueNode>
}

const issueTree = (issues: ReadonlyArray<Issue>): ReadonlyArray<IssueNode> => {
  const byParent = new Map<IssueId | null, Array<Issue>>()
  for (const issue of [...issues].sort((a, b) => a.createdAt - b.createdAt)) {
    const siblings = byParent.get(issue.parentIssueId)
    if (siblings === undefined) byParent.set(issue.parentIssueId, [issue])
    else siblings.push(issue)
  }
  const build = (parent: IssueId | null): ReadonlyArray<IssueNode> =>
    (byParent.get(parent) ?? []).map((issue) => ({ issue, children: build(issue.id) }))
  return build(null)
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('')

const toastIssueFailure = (title: string, failure: { readonly _tag: string }) => {
  toast.add({ title, description: failureText(failure), type: 'error' })
}

const triageIssues = async (
  call: IssuesCall,
  ids: readonly [IssueId, ...Array<IssueId>],
  decision: TriageDecision,
  failureTitle: string
) => {
  const result = await call(TriageIssues, { issueIds: ids, decision }, ids.join(','))
  if (Result.isFailure(result)) toastIssueFailure(failureTitle, result.failure)
}

function Pending({ busy }: { readonly busy: boolean }) {
  return busy ? <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" /> : null
}

function TriageButtons({
  ids,
  call,
  acceptLabel,
  declineLabel,
  failureTitle
}: {
  readonly ids: readonly [IssueId, ...Array<IssueId>]
  readonly call: IssuesCall
  readonly acceptLabel: string
  readonly declineLabel: string
  readonly failureTitle: (decision: TriageDecision) => string
}) {
  const [busy, setBusy] = useState<TriageDecision | null>(null)

  const decide = async (decision: TriageDecision) => {
    setBusy(decision)
    await triageIssues(call, ids, decision, failureTitle(decision)).finally(() => setBusy(null))
  }

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={busy !== null}
        onClick={() => void decide('accept')}
      >
        <Pending busy={busy === 'accept'} />
        {acceptLabel}
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={busy !== null}
        onClick={() => void decide('decline')}
      >
        <Pending busy={busy === 'decline'} />
        {declineLabel}
      </Button>
    </>
  )
}

function TriageBar({
  triage,
  call
}: {
  readonly triage: ReadonlyArray<Issue>
  readonly call: IssuesCall
}) {
  if (!isReadonlyArrayNonEmpty(triage)) return null
  const ids = [triage[0].id, ...triage.slice(1).map((issue) => issue.id)] as const

  return (
    <div className="flex items-center gap-2 border-b pb-2">
      <span className="min-w-0 flex-1 text-sm text-ink-muted">
        {triage.length === 1 ? '1 issue in Triage' : `${triage.length} issues in Triage`}
      </span>
      <TriageButtons
        ids={ids}
        call={call}
        acceptLabel="Accept all"
        declineLabel="Decline all"
        failureTitle={(decision) => `Could not ${decision} the issues`}
      />
    </div>
  )
}

const firstLine = (text: string): string => text.split('\n', 1)[0]?.trim() ?? ''

function IssueComments({
  comments,
  providers
}: {
  readonly comments: ReadonlyArray<IssueComment>
  readonly providers: ReadonlyArray<AssigneeGroup>
}) {
  if (comments.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5 py-1 pl-3">
      {comments.map((comment) => (
        <li key={comment.id} className="flex flex-col text-xs">
          <span className="font-medium text-ink">
            {assigneeLabel(comment.author, providers, 'Removed assignee')}
          </span>
          <span className="max-w-prose whitespace-pre-wrap text-ink-muted">{comment.body}</span>
        </li>
      ))}
    </ul>
  )
}

function AssigneeEntity({
  assignee,
  providers
}: {
  readonly assignee: AssigneeRef | null
  readonly providers: ReadonlyArray<AssigneeGroup>
}) {
  const name = assigneeLabel(assignee, providers, 'Unassigned')
  return (
    <Entity className="w-40 shrink-0 text-xs text-ink-muted">
      <EntityMedia size="default">
        <AvatarFallback>{assignee === null ? '' : initials(name)}</AvatarFallback>
      </EntityMedia>
      <EntityName>{name}</EntityName>
    </Entity>
  )
}

function IssueRow({
  issue,
  providers,
  call
}: {
  readonly issue: Issue
  readonly providers: ReadonlyArray<AssigneeGroup>
  readonly call: IssuesCall
}) {
  const [finishing, setFinishing] = useState(false)

  const assign = async (assignee: AssigneeRef | null) => {
    if (sameAssignee(assignee, issue.assignee)) return
    const result = await call(AssignIssue, { issueId: issue.id, assignee }, issue.id)
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

  const summary = firstLine(issue.description)

  return (
    <div className="flex min-w-0 items-center gap-3 py-1">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={issueTitleVariants({ canceled: issue.status === 'canceled' })}>
          {issue.title}
        </span>
        {summary === '' ? null : <span className="truncate text-xs text-ink-muted">{summary}</span>}
        {issue.status === 'triage' && issue.refusal !== null ? (
          <span className="text-xs text-error">{issue.refusal}</span>
        ) : null}
      </span>
      {KIND_LABELS[issue.kind] === null ? null : (
        <span className="text-xs text-ink-muted">{KIND_LABELS[issue.kind]}</span>
      )}
      <Status className="w-28 shrink-0 text-xs text-ink-muted">
        <StatusMedia fill={statusFill(issue.status)} />
        <StatusName>{STATUS_LABELS[issue.status]}</StatusName>
      </Status>
      {isAssignable(issue.status) ? (
        <AssigneeSelect
          label={`Assignee of ${issue.title}`}
          value={issue.assignee}
          providers={providers}
          className="h-8 w-40"
          onChange={(next) => void assign(next)}
        />
      ) : (
        <AssigneeEntity assignee={issue.assignee} providers={providers} />
      )}
      <span className="flex w-36 shrink-0 justify-end gap-1.5">
        {issue.status === 'triage' ? (
          <TriageButtons
            ids={[issue.id]}
            call={call}
            acceptLabel="Accept"
            declineLabel="Decline"
            failureTitle={(decision) => `Could not ${decision} ${issue.title}`}
          />
        ) : null}
        {isStarted(issue.status) ? (
          <Button size="xs" variant="outline" disabled={finishing} onClick={() => void finish()}>
            <Pending busy={finishing} />
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
  commentsByIssue,
  providers,
  call
}: {
  readonly nodes: ReadonlyArray<IssueNode>
  readonly nested: boolean
  readonly commentsByIssue: ReadonlyMap<IssueId, ReadonlyArray<IssueComment>>
  readonly providers: ReadonlyArray<AssigneeGroup>
  readonly call: IssuesCall
}) {
  if (nodes.length === 0) return null
  return (
    <ul className={nested ? 'ml-3 flex flex-col border-l pl-3' : 'flex flex-col'}>
      {nodes.map((node) => (
        <li key={node.issue.id} aria-label={node.issue.title} className="flex flex-col">
          <IssueRow issue={node.issue} providers={providers} call={call} />
          <IssueComments
            comments={commentsByIssue.get(node.issue.id) ?? []}
            providers={providers}
          />
          <IssueList
            nodes={node.children}
            nested
            commentsByIssue={commentsByIssue}
            providers={providers}
            call={call}
          />
        </li>
      ))}
    </ul>
  )
}

function AddIssue({
  objective,
  providers,
  call
}: {
  readonly objective: Objective
  readonly providers: ReadonlyArray<AssigneeGroup>
  readonly call: IssuesCall
}) {
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState<AssigneeRef | null>(null)
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
    if (Result.isFailure(result)) return setError(failureText(result.failure))
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
          value={assignee}
          providers={providers}
          className="h-8 w-40"
          onChange={setAssignee}
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          <Pending busy={busy} />
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
 * description, then the tree of its issues in `view`, each sub-issue under its parent, with its
 * comments under it. A `triage` or `todo` issue's assignee can change to any assignee a loaded
 * provider lists, a `triage` issue can be accepted or declined singly or all at once from the
 * Triage bar, and a started issue can be finished; an open objective takes new `work` issues.
 * Calls go through `call`.
 */
export function ObjectiveScreen({
  objective,
  projectName,
  view,
  call
}: {
  readonly objective: Objective
  readonly projectName: string
  readonly view: IssuesView
  readonly call: IssuesCall
}) {
  const own = view.issues.filter((issue) => issue.objectiveId === objective.id)
  const commentsByIssue = new Map<IssueId, Array<IssueComment>>()
  for (const comment of view.comments) {
    const onIssue = commentsByIssue.get(comment.issueId)
    if (onIssue === undefined) commentsByIssue.set(comment.issueId, [comment])
    else onIssue.push(comment)
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h3 className="text-base font-semibold text-ink">{objective.title}</h3>
      <dl className="flex flex-col gap-4">
        <SettingsRow label="Project">{projectName}</SettingsRow>
        <SettingsRow label="Priority">{PRIORITY_LABELS[objective.priority]}</SettingsRow>
        <SettingsRow label="State">{objective.state === 'open' ? 'Open' : 'Completed'}</SettingsRow>
        <SettingsRow label="Assignee">
          {assigneeLabel(objective.assignee, view.providers, 'Unassigned')}
        </SettingsRow>
        <SettingsRow label="Description">
          {objective.description === '' ? (
            <span className="text-ink-muted">No description</span>
          ) : (
            <p className="max-w-prose whitespace-pre-wrap">{objective.description}</p>
          )}
        </SettingsRow>
      </dl>
      <section className="flex flex-col gap-3 border-t pt-5" aria-labelledby="objective-issues">
        <h4 id="objective-issues" className="text-sm font-medium text-ink">
          Issues
        </h4>
        {own.length === 0 ? (
          <p className="text-sm text-ink-muted">No issues yet.</p>
        ) : (
          <>
            <TriageBar triage={own.filter((issue) => issue.status === 'triage')} call={call} />
            <IssueList
              nodes={issueTree(own)}
              nested={false}
              commentsByIssue={commentsByIssue}
              providers={view.providers}
              call={call}
            />
          </>
        )}
        {objective.state === 'open' ? (
          <AddIssue objective={objective} providers={view.providers} call={call} />
        ) : null}
      </section>
    </div>
  )
}

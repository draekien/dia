// @effect-diagnostics asyncFunction:off -- the fake stands in for the Promise-based window.dia bridge.
import { ProjectId } from '@dia/plugin'
import { Schema } from 'effect'
import type { Rpc } from 'effect/rpc'
import { vi } from 'vitest'
import * as calls from './calls'
import { IssuesView } from './calls'
import {
  AssigneeRef,
  CommentBody,
  CommentId,
  Issue,
  IssueComment,
  IssueId,
  type IssueKind,
  type IssueStatus,
  NewObjective,
  NewWorkIssue,
  Objective,
  ObjectiveId,
  type ObjectivePriority,
  type ObjectiveState,
  ProviderId,
  Refusal,
  TriageDecision,
  WorkTitle
} from './domain'

/** The provider id of the fixture assignees: `org`. */
export const ORG = ProviderId.make('org')

/** The fixture assignee reference of `org` assignee `n`. */
export const assignee = (n: number): AssigneeRef =>
  AssigneeRef.make({
    provider: ORG,
    id: `00000000-0000-4000-8000-2000000000${String(n).padStart(2, '0')}`
  })

/** The `org` provider listing Ada (1), Bea (2), Quality engineer (3) and Cy (4). */
export const ORG_GROUP = {
  provider: ORG,
  label: 'Org',
  assignees: [
    { id: assignee(1).id, name: 'Ada', detail: 'Team lead' },
    { id: assignee(2).id, name: 'Bea', detail: 'Software engineer' },
    { id: assignee(3).id, name: 'Quality engineer', detail: 'Quality engineer' },
    { id: assignee(4).id, name: 'Cy', detail: 'Product manager' }
  ]
}

/** The two registered projects of the fake workspace: `dia`, then `website`. */
export const PROJECTS = [
  { id: ProjectId.make('00000000-0000-4000-8000-300000000001'), name: 'dia' },
  { id: ProjectId.make('00000000-0000-4000-8000-300000000002'), name: 'website' }
] as const

/** An objective id for fixture objective `n`. */
export const objectiveId = (n: number) =>
  ObjectiveId.make(`00000000-0000-4000-8000-4000000000${String(n).padStart(2, '0')}`)

/** An issue id for fixture issue `n`. */
export const issueId = (n: number) =>
  IssueId.make(`00000000-0000-4000-8000-5000000000${String(n).padStart(2, '0')}`)

const objective = (
  n: number,
  title: string,
  options: {
    readonly project: 0 | 1
    readonly priority: ObjectivePriority
    readonly assignee: number | null
    readonly state?: ObjectiveState
    readonly description?: string
  }
) =>
  Objective.make({
    id: objectiveId(n),
    projectId: PROJECTS[options.project].id,
    title: WorkTitle.make(title),
    description: options.description ?? '',
    priority: options.priority,
    assignee: options.assignee === null ? null : assignee(options.assignee),
    state: options.state ?? 'open',
    createdAt: Date.UTC(2026, 10, 1, n)
  })

const issue = (
  n: number,
  objectiveN: number,
  title: string,
  options: {
    readonly status: IssueStatus
    readonly assignee: number | null
    readonly parent?: number
    readonly kind?: IssueKind
    readonly description?: string
  }
) =>
  Issue.make({
    id: issueId(n),
    objectiveId: objectiveId(objectiveN),
    parentIssueId: options.parent === undefined ? null : issueId(options.parent),
    kind: options.kind ?? 'work',
    title: WorkTitle.make(title),
    description: options.description ?? '',
    status: options.status,
    assignee: options.assignee === null ? null : assignee(options.assignee),
    paneId: `00000000-0000-4000-8000-6000000000${String(n).padStart(2, '0')}`,
    sessionId: null,
    refusal: null,
    createdAt: Date.UTC(2026, 10, 2, n)
  })

const comment = (n: number, issueN: number, author: number | null, body: string) =>
  IssueComment.make({
    id: CommentId.make(`00000000-0000-4000-8000-7000000000${String(n).padStart(2, '0')}`),
    issueId: issueId(issueN),
    author: author === null ? null : assignee(author),
    body: CommentBody.make(body),
    createdAt: Date.UTC(2026, 10, 3, n)
  })

/**
 * Three objectives: `Tidy release notes` (normal, website, unassigned, objective 2), `Ship the
 * objective screen` (high, dia, Ada, objective 1) and the completed `Move settings to SQLite`
 * (low, dia, objective 3). Objective 1 has its done planning issue 1; an `implementing` issue 2
 * (Bea) with a `todo` sub-issue 3; a done issue 4 with its `todo` retro issue 5 (Ada); an
 * unassigned `todo` issue 6; `triage` issues 7 and 8; an `in_review` issue 9 (agent 3); and a
 * `canceled` issue 10. Issue 2 has a comment by Bea and issue 9 one with no author. The `org`
 * provider is {@link ORG_GROUP}.
 */
export const VIEW: IssuesView = {
  objectives: [
    objective(1, 'Ship the objective screen', {
      project: 0,
      priority: 'high',
      assignee: 1,
      description: 'List objectives beside a detail, and show every issue with its status.'
    }),
    objective(2, 'Tidy release notes', { project: 1, priority: 'normal', assignee: null }),
    objective(3, 'Move settings to SQLite', {
      project: 0,
      priority: 'low',
      assignee: 2,
      state: 'completed'
    })
  ],
  issues: [
    issue(1, 1, 'Plan: Ship the objective screen', {
      status: 'done',
      assignee: 1,
      kind: 'planning'
    }),
    issue(2, 1, 'Build the objective screen', {
      status: 'implementing',
      assignee: 2,
      description: 'A list of objectives beside the selected one.\nShow its issues as a tree.'
    }),
    issue(3, 1, 'Test the issue tree', { status: 'todo', assignee: null, parent: 2 }),
    issue(4, 1, 'Stream the work view', { status: 'done', assignee: 1 }),
    issue(5, 1, 'Retro: Stream the work view', {
      status: 'todo',
      assignee: 1,
      parent: 4,
      kind: 'retro'
    }),
    issue(6, 1, 'Write the release note', { status: 'todo', assignee: null }),
    issue(7, 1, 'Add keyboard shortcuts', {
      status: 'triage',
      assignee: null,
      description: 'Arrow keys move between objectives.'
    }),
    issue(8, 1, 'Document the statuses', { status: 'triage', assignee: null }),
    issue(9, 1, 'Show the status labels', { status: 'in_review', assignee: 3 }),
    issue(10, 1, 'Export objectives as CSV', { status: 'canceled', assignee: null })
  ],
  comments: [
    comment(1, 2, 2, 'The tree nests sub-issues under their parent.'),
    comment(2, 9, null, 'Ready for review.')
  ],
  providers: [ORG_GROUP]
}

/** `view` with issue `n` replaced by `change` of it. */
export const withIssue = (
  view: IssuesView,
  n: number,
  change: (existing: Issue) => Issue
): IssuesView => ({
  ...view,
  issues: view.issues.map((existing) => (existing.id === issueId(n) ? change(existing) : existing))
})

/** A refusal for a fixture issue. */
export const refusal = (text: string) => Refusal.make(text)

const WORKSPACE = {
  projects: PROJECTS.map((project) => ({
    project: {
      projectId: project.id,
      directory: `/dev/${project.name}`,
      directoryKey: `/dev/${project.name}`,
      displayName: project.name,
      isGitRepo: true
    },
    tabs: []
  })),
  visibleTab: null
}

const RPCS: Record<string, Rpc.AnyWithProps> = Object.fromEntries(
  [
    calls.CreateObjective,
    calls.CreateIssue,
    calls.AssignIssue,
    calls.TriageIssues,
    calls.FinishIssue
  ].map((rpc: Rpc.AnyWithProps) => [rpc._tag, rpc])
)

/** What the fake host entry answers to one call: its success value, its error, or a plugin failure. */
export type Reply =
  | { readonly value: unknown }
  | { readonly error: unknown }
  | { readonly notServing: string }

/**
 * A fake `issues` host entry behind `window.dia.plugins.call` and `window.dia.plugins.subscribe`.
 * `push` replaces `view` and sends it to every `WatchIssues` subscriber.
 */
export interface FakeIssuesHost {
  view: IssuesView
  readonly sent: Array<readonly [string, unknown]>
  readonly push: (view: IssuesView) => void
}

const decodeObjective = Schema.decodeUnknownSync(Schema.toCodecJson(NewObjective))
const decodeIssue = Schema.decodeUnknownSync(Schema.toCodecJson(NewWorkIssue))
const decodeAssignee = Schema.decodeUnknownSync(Schema.NullOr(AssigneeRef))
const decodeDecision = Schema.decodeUnknownSync(TriageDecision)

const FAKE_NOW = Date.UTC(2026, 10, 8)

const changeIssues = (
  host: FakeIssuesHost,
  ids: ReadonlyArray<unknown>,
  change: (existing: Issue) => Issue
): ReadonlyArray<Issue> => {
  const issues = host.view.issues.map((existing) =>
    ids.includes(existing.id) ? change(existing) : existing
  )
  host.push({ ...host.view, issues })
  return issues.filter((existing) => ids.includes(existing.id))
}

const defaultReply = (
  host: FakeIssuesHost,
  tag: string,
  payload: Record<string, unknown>
): Reply => {
  switch (tag) {
    case 'CreateObjective': {
      const created = Objective.make({
        ...decodeObjective(payload.objective),
        state: 'open',
        createdAt: FAKE_NOW
      })
      host.push({ ...host.view, objectives: [...host.view.objectives, created] })
      return { value: created }
    }
    case 'CreateIssue': {
      const created = Issue.make({
        ...decodeIssue(payload.issue),
        kind: 'work',
        status: 'todo',
        paneId: '00000000-0000-4000-8000-600000000099',
        sessionId: null,
        refusal: null,
        createdAt: FAKE_NOW
      })
      host.push({ ...host.view, issues: [...host.view.issues, created] })
      return { value: created }
    }
    case 'AssignIssue': {
      const [changed] = changeIssues(host, [payload.issueId], (existing) =>
        Issue.make({ ...existing, assignee: decodeAssignee(payload.assignee) })
      )
      return { value: changed }
    }
    case 'TriageIssues': {
      const status = decodeDecision(payload.decision) === 'accept' ? 'todo' : 'canceled'
      const ids = Array.isArray(payload.issueIds) ? payload.issueIds : []
      return {
        value: changeIssues(host, ids, (existing) =>
          Issue.make({ ...existing, status, refusal: null })
        )
      }
    }
    case 'FinishIssue': {
      const [finished] = changeIssues(host, [payload.issueId], (existing) =>
        Issue.make({ ...existing, status: 'done' })
      )
      return { value: finished }
    }
    default:
      throw new Error(`no default reply for ${tag}`)
  }
}

const encodeView = Schema.encodeSync(Schema.toCodecJson(IssuesView))

/**
 * Installs a fake `issues` host entry holding `view`, and a workspace of {@link PROJECTS}.
 * `WatchIssues` sends the current view, then each pushed one. Every call is recorded in `sent` with
 * its encoded payload and answered by `replies[tag]`, or else by applying it to the view and pushing
 * the changed view.
 */
export const installIssuesHost = (
  replies: Record<string, (payload: Record<string, unknown>, host: FakeIssuesHost) => Reply> = {},
  view: IssuesView = VIEW
): FakeIssuesHost => {
  const watchers = new Set<(value: unknown) => void>()
  const host: FakeIssuesHost = {
    view,
    sent: [],
    push: (next) => {
      host.view = next
      for (const watcher of watchers) watcher(encodeView(next))
    }
  }
  const subscribe = (
    _plugin: string,
    tag: string,
    _payload: unknown,
    onValue: (value: unknown) => void
  ) => {
    if (tag !== 'WatchIssues') throw new Error(`unknown subscription ${tag}`)
    watchers.add(onValue)
    queueMicrotask(() => {
      if (watchers.has(onValue)) onValue(encodeView(host.view))
    })
    return () => watchers.delete(onValue)
  }
  const call = vi.fn(async (_plugin: string, tag: string, payload: Record<string, unknown>) => {
    const rpc = RPCS[tag]
    if (rpc === undefined) throw new Error(`unknown call ${tag}`)
    host.sent.push([tag, payload])
    const reply = replies[tag]?.(payload, host) ?? defaultReply(host, tag, payload)
    if ('notServing' in reply) {
      return {
        _tag: 'Failure',
        error: { _tag: 'PluginNotServing', plugin: 'issues', tag, message: reply.notServing }
      }
    }
    if ('error' in reply) {
      return {
        _tag: 'Failure',
        error: {
          _tag: 'PluginCallFailed',
          error: Schema.encodeSync(
            Schema.toCodecJson(rpc.errorSchema as Schema.Codec<unknown, unknown>)
          )(reply.error)
        }
      }
    }
    return {
      _tag: 'Success',
      value: Schema.encodeSync(
        Schema.toCodecJson(rpc.successSchema as Schema.Codec<unknown, unknown>)
      )(reply.value)
    }
  })
  Object.assign(window, {
    dia: {
      plugins: { call, subscribe, onStatusChanged: () => () => {} },
      getWorkspace: async () => WORKSPACE,
      onWorkspaceChanged: () => () => {},
      onAgentSummariesReplaced: () => () => {},
      selectTab: () => {}
    }
  })
  return host
}

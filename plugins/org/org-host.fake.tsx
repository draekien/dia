// @effect-diagnostics asyncFunction:off -- the fake stands in for the Promise-based window.dia bridge.
import { AgentName, ProjectId } from '@dia/plugin'
import { Schema } from 'effect'
import type { Rpc } from 'effect/rpc'
import { vi } from 'vitest'
import * as calls from './calls'
import { OrgSnapshot, WorkView } from './calls'
import {
  type BuiltInJobTitle,
  CommentBody,
  CommentId,
  HiredAgent,
  HireId,
  Issue,
  IssueComment,
  IssueId,
  type IssueKind,
  type IssueStatus,
  JobTitle,
  JobTitleId,
  JobTitleName,
  NewIssue,
  NewObjective,
  Objective,
  ObjectiveId,
  type ObjectivePriority,
  type ObjectiveState,
  OverallCap,
  TriageDecision,
  WORK_TITLE_MAX_LENGTH,
  WorkTitle
} from './domain'

const BUILT_INS: ReadonlyArray<readonly [BuiltInJobTitle, string]> = [
  ['product-manager', 'Product manager'],
  ['software-engineer', 'Software engineer'],
  ['quality-engineer', 'Quality engineer'],
  ['business-analyst', 'Business analyst'],
  ['ui-ux', 'UI/UX designer'],
  ['team-lead', 'Team lead'],
  ['technical-lead', 'Technical lead']
]

const jobTitleId = (n: number) =>
  JobTitleId.make(`00000000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`)

/** A hire id for fixture agent `n`. */
export const hireId = (n: number) =>
  HireId.make(`00000000-0000-4000-8000-2000000000${String(n).padStart(2, '0')}`)

const jobTitle = (n: number, name: string, builtIn: BuiltInJobTitle | null): JobTitle =>
  JobTitle.make({
    id: jobTitleId(n),
    name: JobTitleName.make(name),
    builtIn,
    enabled: true,
    jobDescription: `Works as a ${name}.`,
    skills: [],
    permissions: { allow: [], ask: [], deny: [] },
    mcpServers: {},
    bypassOptIn: false,
    model: null,
    thinkingLevel: 'medium'
  })

/** The seven built-in job titles and one copy, `Reviewer`, the last entry. */
export const JOB_TITLES: ReadonlyArray<JobTitle> = [
  ...BUILT_INS.map(([kind, name], index) => jobTitle(index + 1, name, kind)),
  jobTitle(8, 'Reviewer', null)
]

/** The fixture job title named `name`. */
export const jobTitleNamed = (name: string): JobTitle => {
  const found = JOB_TITLES.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no fixture job title ${name}`)
  return found
}

const agent = (n: number, name: string | null, title: string, reportsTo: number | null) =>
  HiredAgent.make({
    id: hireId(n),
    jobTitleId: jobTitleNamed(title).id,
    name: name === null ? null : AgentName.make(name),
    bypassOverride: null,
    reportsTo: reportsTo === null ? null : hireId(reportsTo),
    hiredAt: Date.UTC(2026, 10, n)
  })

/**
 * Four hires: Ada (Team lead) and Cy (Product manager) report to the user, Bea (Software engineer)
 * reports to Ada, and an unnamed Quality engineer (agent 3) reports to Bea.
 */
export const HIRES: ReadonlyArray<HiredAgent> = [
  agent(1, 'Ada', 'Team lead', null),
  agent(2, 'Bea', 'Software engineer', 1),
  agent(3, null, 'Quality engineer', 2),
  agent(4, 'Cy', 'Product manager', null)
]

/** The fixture snapshot, with `overrides` applied. */
export const snapshotOf = (overrides: Partial<OrgSnapshot> = {}): OrgSnapshot => ({
  jobTitles: JOB_TITLES,
  hiredAgents: HIRES,
  settings: { overallCap: OverallCap.make(4) },
  bypassAvailable: true,
  ...overrides
})

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
    assignee: options.assignee === null ? null : hireId(options.assignee),
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
    assignee: options.assignee === null ? null : hireId(options.assignee),
    paneId: `00000000-0000-4000-8000-6000000000${String(n).padStart(2, '0')}`,
    sessionId: null,
    createdAt: Date.UTC(2026, 10, 2, n)
  })

const comment = (n: number, issueN: number, author: number | null, body: string) =>
  IssueComment.make({
    id: CommentId.make(`00000000-0000-4000-8000-7000000000${String(n).padStart(2, '0')}`),
    issueId: issueId(issueN),
    author: author === null ? null : hireId(author),
    body: CommentBody.make(body),
    createdAt: Date.UTC(2026, 10, 3, n)
  })

/**
 * Three objectives: `Tidy release notes` (normal, website, unassigned, objective 2), `Ship the
 * objective screen` (high, dia, Ada, objective 1) and the completed `Move settings to SQLite`
 * (low, dia, objective 3). Objective 1 has its done planning issue 1; an `implementing` issue 2
 * (Bea) with a `todo` sub-issue 3; a done issue 4 with its `todo` retro issue 5 (Ada); an
 * unassigned `todo` issue 6; `triage` issues 7 and 8; an `in_review` issue 9 (agent 3); and a
 * `canceled` issue 10. Issue 2 has a comment by Bea and issue 9 one by a dismissed agent.
 */
export const WORK: WorkView = {
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
  pendingPermissions: [],
  heldSlots: 1
}

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
    calls.ReadOrg,
    calls.CreateObjective,
    calls.CreateIssue,
    calls.AssignIssue,
    calls.TriageIssues,
    calls.FinishIssue,
    calls.SetJobTitleEnabled,
    calls.CopyJobTitle,
    calls.EditJobTitle,
    calls.DeleteJobTitle,
    calls.Hire,
    calls.Dismiss,
    calls.RenameHire,
    calls.SetBypassOverride,
    calls.SetReportsTo,
    calls.SetOverallCap
  ].map((rpc: Rpc.AnyWithProps) => [rpc._tag, rpc])
)

/** What the fake host entry answers to one call: its success value, its error, or a plugin failure. */
export type Reply =
  | { readonly value: unknown }
  | { readonly error: unknown }
  | { readonly notServing: string }

const fakeModel = (value: string, displayName: string) => ({
  value,
  displayName,
  description: '',
  adaptiveThinking: true,
  effortLevels: ['low', 'medium', 'high'],
  autoMode: true,
  fastMode: false
})

/** The model catalog the fake bridge reports: `Default model`, then `Opus`. */
const FAKE_MODELS = {
  onChanged: () => () => {},
  get: async () => ({
    revision: 1,
    state: {
      _tag: 'Ready',
      models: [fakeModel('default', 'Default model'), fakeModel('opus', 'Opus')],
      fetchedAt: '2026-11-08T00:00:00.000Z',
      refreshing: false
    }
  }),
  refresh: async () => {}
}

/**
 * A fake `org` host entry behind `window.dia.plugins.call` and `window.dia.plugins.subscribe`.
 * `push` replaces `work` and sends it to every `WatchWork` subscriber.
 */
export interface FakeHost {
  snapshot: OrgSnapshot
  work: WorkView
  readonly sent: Array<readonly [string, unknown]>
  readonly reads: () => number
  readonly push: (work: WorkView) => void
}

const decodeObjective = Schema.decodeUnknownSync(Schema.toCodecJson(NewObjective))
const decodeIssue = Schema.decodeUnknownSync(Schema.toCodecJson(NewIssue))
const decodeDecision = Schema.decodeUnknownSync(TriageDecision)

const FAKE_NOW = Date.UTC(2026, 10, 8)

const newIssue = (fields: Omit<Issue, 'paneId' | 'sessionId' | 'createdAt'>): Issue =>
  Issue.make({
    ...fields,
    paneId: '00000000-0000-4000-8000-600000000099',
    sessionId: null,
    createdAt: FAKE_NOW
  })

const prefixed = (prefix: string, title: string) =>
  WorkTitle.make(`${prefix}: ${title}`.slice(0, WORK_TITLE_MAX_LENGTH).trimEnd())

const changeIssues = (
  host: FakeHost,
  ids: ReadonlyArray<unknown>,
  change: (existing: Issue) => Issue
): ReadonlyArray<Issue> => {
  const issues = host.work.issues.map((existing) =>
    ids.includes(existing.id) ? change(existing) : existing
  )
  host.push({ ...host.work, issues })
  return issues.filter((existing) => ids.includes(existing.id))
}

const finishIssue = (host: FakeHost, id: unknown): Issue | undefined => {
  const [finished] = changeIssues(host, [id], (existing) =>
    Issue.make({ ...existing, status: 'done' })
  )
  if (finished?.kind === 'work') {
    const retro = newIssue({
      id: IssueId.make('00000000-0000-4000-8000-500000000098'),
      objectiveId: finished.objectiveId,
      parentIssueId: finished.id,
      kind: 'retro',
      title: prefixed('Retro', finished.title),
      description: '',
      status: 'todo',
      assignee: null
    })
    host.push({ ...host.work, issues: [...host.work.issues, retro] })
  }
  return finished
}

const workReply = (
  host: FakeHost,
  tag: string,
  payload: Record<string, unknown>
): Reply | undefined => {
  switch (tag) {
    case 'CreateObjective': {
      const created = Objective.make({
        ...decodeObjective(payload.objective),
        state: 'open',
        createdAt: FAKE_NOW
      })
      const planning = newIssue({
        id: IssueId.make('00000000-0000-4000-8000-500000000097'),
        objectiveId: created.id,
        parentIssueId: null,
        kind: 'planning',
        title: prefixed('Plan', created.title),
        description: '',
        status: 'todo',
        assignee: created.assignee
      })
      host.push({
        ...host.work,
        objectives: [...host.work.objectives, created],
        issues: [...host.work.issues, planning]
      })
      return { value: created }
    }
    case 'CreateIssue': {
      const created = newIssue({ ...decodeIssue(payload.issue), kind: 'work', status: 'todo' })
      host.push({ ...host.work, issues: [...host.work.issues, created] })
      return { value: created }
    }
    case 'AssignIssue': {
      const [changed] = changeIssues(host, [payload.issueId], (existing) =>
        Issue.make({ ...existing, assignee: (payload.hireId as HireId | null) ?? null })
      )
      return { value: changed }
    }
    case 'TriageIssues': {
      const status = decodeDecision(payload.decision) === 'accept' ? 'todo' : 'canceled'
      const ids = Array.isArray(payload.issueIds) ? payload.issueIds : []
      return { value: changeIssues(host, ids, (existing) => Issue.make({ ...existing, status })) }
    }
    case 'FinishIssue':
      return { value: finishIssue(host, payload.issueId) }
    default:
      return undefined
  }
}

const defaultReply = (host: FakeHost, tag: string, payload: Record<string, unknown>): Reply => {
  const work = workReply(host, tag, payload)
  if (work !== undefined) return work
  if (tag === 'SetOverallCap') return { value: { overallCap: payload.cap } }
  if (typeof payload.hireId === 'string') {
    return { value: host.snapshot.hiredAgents.find((hire) => hire.id === payload.hireId) }
  }
  if (typeof payload.jobTitleId === 'string' && tag !== 'Hire') {
    return { value: host.snapshot.jobTitles.find((title) => title.id === payload.jobTitleId) }
  }
  return { value: undefined }
}

const encodeWork = Schema.encodeSync(Schema.toCodecJson(WorkView))

/**
 * Installs a fake `org` host entry holding `snapshot` and `work`, and a workspace of
 * {@link PROJECTS}. `ReadOrg` answers the current snapshot and `WatchWork` sends the current
 * work, then each pushed one. Every other call is recorded in `sent` with its encoded payload and
 * answered by `replies[tag]`, or else by the matching snapshot entry; the objective and issue
 * calls also push the changed work.
 */
export const installHost = (
  snapshot: OrgSnapshot,
  replies: Record<string, (payload: Record<string, unknown>, host: FakeHost) => Reply> = {},
  work: WorkView = WORK
): FakeHost => {
  let reads = 0
  const watchers = new Set<(value: unknown) => void>()
  const host: FakeHost = {
    snapshot,
    work,
    sent: [],
    reads: () => reads,
    push: (next) => {
      host.work = next
      for (const watcher of watchers) watcher(encodeWork(next))
    }
  }
  const subscribe = (
    _plugin: string,
    tag: string,
    _payload: unknown,
    onValue: (value: unknown) => void
  ) => {
    if (tag !== 'WatchWork') throw new Error(`unknown subscription ${tag}`)
    watchers.add(onValue)
    queueMicrotask(() => {
      if (watchers.has(onValue)) onValue(encodeWork(host.work))
    })
    return () => watchers.delete(onValue)
  }
  const call = vi.fn(async (_plugin: string, tag: string, payload: Record<string, unknown>) => {
    const rpc = RPCS[tag]
    if (rpc === undefined) throw new Error(`unknown call ${tag}`)
    if (tag === 'ReadOrg') {
      reads += 1
      return {
        _tag: 'Success',
        value: Schema.encodeSync(Schema.toCodecJson(OrgSnapshot))(host.snapshot)
      }
    }
    host.sent.push([tag, payload])
    const reply = replies[tag]?.(payload, host) ?? defaultReply(host, tag, payload)
    if ('notServing' in reply) {
      return {
        _tag: 'Failure',
        error: { _tag: 'PluginNotServing', plugin: 'org', tag, message: reply.notServing }
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
      models: FAKE_MODELS,
      getWorkspace: async () => WORKSPACE,
      onWorkspaceChanged: () => () => {},
      onAgentSummariesReplaced: () => () => {},
      selectTab: () => {}
    }
  })
  return host
}

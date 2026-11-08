// @effect-diagnostics asyncFunction:off -- the fake stands in for the Promise-based window.dia bridge.
import { AgentName, ProjectId } from '@dia/plugin'
import { Schema } from 'effect'
import type { Rpc } from 'effect/rpc'
import { vi } from 'vitest'
import * as calls from './calls'
import { OrgSnapshot, WorkView } from './calls'
import {
  type BuiltInJobTitle,
  HiredAgent,
  HireId,
  JobTitle,
  JobTitleId,
  JobTitleName,
  NewObjective,
  NewTask,
  Objective,
  ObjectiveId,
  type ObjectivePriority,
  type ObjectiveState,
  OverallCap,
  Task,
  TaskId,
  type TaskKind,
  type TaskState,
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

/** A task id for fixture task `n`. */
export const taskId = (n: number) =>
  TaskId.make(`00000000-0000-4000-8000-5000000000${String(n).padStart(2, '0')}`)

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

const task = (
  n: number,
  objectiveN: number,
  title: string,
  options: {
    readonly state: TaskState
    readonly assignee: number | null
    readonly parent?: number
    readonly kind?: TaskKind
  }
) =>
  Task.make({
    id: taskId(n),
    objectiveId: objectiveId(objectiveN),
    parentTaskId: options.parent === undefined ? null : taskId(options.parent),
    kind: options.kind ?? 'work',
    title: WorkTitle.make(title),
    state: options.state,
    assignee: options.assignee === null ? null : hireId(options.assignee),
    paneId: `00000000-0000-4000-8000-6000000000${String(n).padStart(2, '0')}`,
    sessionId: null,
    createdAt: Date.UTC(2026, 10, 2, n)
  })

/**
 * Three objectives: `Tidy release notes` (normal, website, unassigned, objective 2), `Ship the
 * objective screen` (high, dia, Ada, objective 1) and the completed `Move settings to SQLite`
 * (low, dia, objective 3). Objective 1 has a running task 1 with a waiting sub-task 2, a finished
 * task 3 with its waiting retro task 4, and an unassigned waiting task 5.
 */
export const WORK: WorkView = {
  objectives: [
    objective(1, 'Ship the objective screen', {
      project: 0,
      priority: 'high',
      assignee: 1,
      description: 'List objectives beside a detail, and show every task with its state.'
    }),
    objective(2, 'Tidy release notes', { project: 1, priority: 'normal', assignee: null }),
    objective(3, 'Move settings to SQLite', {
      project: 0,
      priority: 'low',
      assignee: 2,
      state: 'completed'
    })
  ],
  tasks: [
    task(1, 1, 'Build the objective screen', { state: 'running', assignee: 2 }),
    task(2, 1, 'Test the task tree', { state: 'waiting', assignee: null, parent: 1 }),
    task(3, 1, 'Stream the work view', { state: 'finished', assignee: 1 }),
    task(4, 1, 'Retro: Stream the work view', {
      state: 'waiting',
      assignee: 1,
      parent: 3,
      kind: 'retro'
    }),
    task(5, 1, 'Write the release note', { state: 'waiting', assignee: null })
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
    calls.CreateTask,
    calls.AssignTask,
    calls.FinishTask,
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
const decodeTask = Schema.decodeUnknownSync(Schema.toCodecJson(NewTask))

const workReply = (
  host: FakeHost,
  tag: string,
  payload: Record<string, unknown>
): Reply | undefined => {
  const now = Date.UTC(2026, 10, 8)
  switch (tag) {
    case 'CreateObjective': {
      const created = Objective.make({
        ...decodeObjective(payload.objective),
        state: 'open',
        createdAt: now
      })
      host.push({ ...host.work, objectives: [...host.work.objectives, created] })
      return { value: created }
    }
    case 'CreateTask': {
      const created = Task.make({
        ...decodeTask(payload.task),
        kind: 'work',
        state: 'waiting',
        paneId: '00000000-0000-4000-8000-600000000099',
        sessionId: null,
        createdAt: now
      })
      host.push({ ...host.work, tasks: [...host.work.tasks, created] })
      return { value: created }
    }
    case 'AssignTask':
    case 'FinishTask': {
      const changed = host.work.tasks.map((existing) =>
        existing.id !== payload.taskId
          ? existing
          : tag === 'FinishTask'
            ? Task.make({ ...existing, state: 'finished' })
            : Task.make({ ...existing, assignee: (payload.hireId as HireId | null) ?? null })
      )
      host.push({ ...host.work, tasks: changed })
      return { value: changed.find((existing) => existing.id === payload.taskId) }
    }
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
 * answered by `replies[tag]`, or else by the matching snapshot entry; the objective and task
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

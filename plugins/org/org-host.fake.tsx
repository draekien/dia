// @effect-diagnostics asyncFunction:off -- the fake stands in for the Promise-based window.dia bridge.
import { AgentName, ProjectId } from '@dia/plugin'
import { Schema } from 'effect'
import type { Rpc } from 'effect/rpc'
import { vi } from 'vitest'
import * as calls from './calls'
import { OrgLive, OrgSnapshot } from './calls'
import {
  type BuiltInJobTitle,
  HiredAgent,
  HireId,
  JobTitle,
  JobTitleId,
  JobTitleName,
  OverallCap
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
    mcpServers: [],
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

/** The registered project of the fake workspace: `dia`. */
const PROJECTS = [
  { id: ProjectId.make('00000000-0000-4000-8000-300000000001'), name: 'dia' }
] as const

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
 * `push` replaces `live` and sends it to every `WatchOrgLive` subscriber.
 */
export interface FakeHost {
  snapshot: OrgSnapshot
  live: OrgLive
  readonly sent: Array<readonly [string, unknown]>
  readonly reads: () => number
  readonly push: (live: OrgLive) => void
}

const defaultReply = (host: FakeHost, tag: string, payload: Record<string, unknown>): Reply => {
  if (tag === 'SetOverallCap') return { value: { overallCap: payload.cap } }
  if (typeof payload.hireId === 'string') {
    return { value: host.snapshot.hiredAgents.find((hire) => hire.id === payload.hireId) }
  }
  if (typeof payload.jobTitleId === 'string' && tag !== 'Hire') {
    return { value: host.snapshot.jobTitles.find((title) => title.id === payload.jobTitleId) }
  }
  return { value: undefined }
}

const encodeLive = Schema.encodeSync(Schema.toCodecJson(OrgLive))

/**
 * Installs a fake `org` host entry holding `snapshot` and `live`, and a workspace of one project.
 * `ReadOrg` answers the current snapshot and `WatchOrgLive` sends the current live state, then
 * each pushed one. Every other call is recorded in `sent` with its encoded payload and answered by
 * `replies[tag]`, or else by the matching snapshot entry.
 */
export const installHost = (
  snapshot: OrgSnapshot,
  replies: Record<string, (payload: Record<string, unknown>, host: FakeHost) => Reply> = {},
  live: OrgLive = { assistantMissing: [] }
): FakeHost => {
  let reads = 0
  const watchers = new Set<(value: unknown) => void>()
  const host: FakeHost = {
    snapshot,
    live,
    sent: [],
    reads: () => reads,
    push: (next) => {
      host.live = next
      for (const watcher of watchers) watcher(encodeLive(next))
    }
  }
  const subscribe = (
    _plugin: string,
    tag: string,
    _payload: unknown,
    onValue: (value: unknown) => void
  ) => {
    if (tag !== 'WatchOrgLive') throw new Error(`unknown subscription ${tag}`)
    watchers.add(onValue)
    queueMicrotask(() => {
      if (watchers.has(onValue)) onValue(encodeLive(host.live))
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

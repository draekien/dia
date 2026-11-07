// @effect-diagnostics asyncFunction:off -- the fake stands in for the Promise-based window.dia bridge.
import { AgentName } from '@dia/plugin'
import { jsonCodec } from '@shared/plugin/messages'
import { Schema } from 'effect'
import type { Rpc } from 'effect/rpc'
import { vi } from 'vitest'
import * as calls from './calls'
import { OrgSnapshot } from './calls'
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
    mcpServers: {},
    bypassOptIn: false
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

/** A fake `org` host entry behind `window.dia.plugins.call`. */
export interface FakeHost {
  snapshot: OrgSnapshot
  readonly sent: Array<readonly [string, unknown]>
  readonly reads: () => number
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

/**
 * Installs a fake `org` host entry holding `snapshot`. `ReadOrg` answers the current snapshot;
 * every other call is recorded in `sent` with its encoded payload and answered by `replies[tag]`,
 * or by the matching snapshot entry when no reply is given.
 */
export const installHost = (
  snapshot: OrgSnapshot,
  replies: Record<string, (payload: Record<string, unknown>, host: FakeHost) => Reply> = {}
): FakeHost => {
  let reads = 0
  const host: FakeHost = { snapshot, sent: [], reads: () => reads }
  const call = vi.fn(async (_plugin: string, tag: string, payload: Record<string, unknown>) => {
    const rpc = RPCS[tag]
    if (rpc === undefined) throw new Error(`unknown call ${tag}`)
    if (tag === 'ReadOrg') {
      reads += 1
      return {
        _tag: 'Success',
        value: Schema.encodeSync(jsonCodec(OrgSnapshot))(host.snapshot)
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
          error: Schema.encodeSync(jsonCodec(rpc.errorSchema))(reply.error)
        }
      }
    }
    return { _tag: 'Success', value: Schema.encodeSync(jsonCodec(rpc.successSchema))(reply.value) }
  })
  Object.assign(window, { dia: { plugins: { call } } })
  return host
}

import { type AgentName, ServiceKey } from '@dia/plugin'
import { Effect, Predicate } from 'effect'
import type {
  BuiltInJobTitleDeleted,
  BuiltInJobTitleRenamed,
  HiredAgent,
  HireId,
  HireNameTaken,
  HireNotFound,
  JobTitle,
  JobTitleDisabled,
  JobTitleEdit,
  JobTitleHasHires,
  JobTitleId,
  JobTitleName,
  JobTitleNameTaken,
  JobTitleNotFound,
  OrgSettings,
  OverallCap
} from './domain'

/**
 * The org (ADR-0033), as the `org` plugin provides it under {@link OrgService}. Reads return the
 * current state; each change is one transaction and returns the changed value. A job title's cap is
 * the number of hired agents of that job title. `jobTitles` lists the built-in job titles in seed
 * order, then copies in creation order; `hiredAgents` lists by `hiredAt`, then creation order. A
 * database failure, or a failure to generate an id, is a defect.
 *
 * `copyJobTitle` copies every field of `jobTitleId` into a new enabled job title named `name` that
 * is not built in. `editJobTitle` applies `edit`'s present fields. `deleteJobTitle` deletes a copy
 * with no hired agents. `hire` hires an agent of an enabled job title, named `name` or unnamed when
 * null. `dismiss` removes a hired agent.
 */
export interface Org {
  readonly jobTitles: Effect.Effect<ReadonlyArray<JobTitle>>
  readonly hiredAgents: Effect.Effect<ReadonlyArray<HiredAgent>>
  readonly settings: Effect.Effect<OrgSettings>
  readonly setJobTitleEnabled: (
    jobTitleId: JobTitleId,
    enabled: boolean
  ) => Effect.Effect<JobTitle, JobTitleNotFound>
  readonly copyJobTitle: (
    jobTitleId: JobTitleId,
    name: JobTitleName
  ) => Effect.Effect<JobTitle, JobTitleNotFound | JobTitleNameTaken>
  readonly editJobTitle: (
    jobTitleId: JobTitleId,
    edit: JobTitleEdit
  ) => Effect.Effect<JobTitle, JobTitleNotFound | JobTitleNameTaken | BuiltInJobTitleRenamed>
  readonly deleteJobTitle: (
    jobTitleId: JobTitleId
  ) => Effect.Effect<void, JobTitleNotFound | BuiltInJobTitleDeleted | JobTitleHasHires>
  readonly hire: (
    jobTitleId: JobTitleId,
    name: AgentName | null
  ) => Effect.Effect<HiredAgent, JobTitleNotFound | JobTitleDisabled | HireNameTaken>
  readonly dismiss: (hireId: HireId) => Effect.Effect<void, HireNotFound>
  readonly setOverallCap: (cap: OverallCap) => Effect.Effect<OrgSettings>
}

const MEMBERS: Record<keyof Org, (member: unknown) => boolean> = {
  jobTitles: Effect.isEffect,
  hiredAgents: Effect.isEffect,
  settings: Effect.isEffect,
  setJobTitleEnabled: Predicate.isFunction,
  copyJobTitle: Predicate.isFunction,
  editJobTitle: Predicate.isFunction,
  deleteJobTitle: Predicate.isFunction,
  hire: Predicate.isFunction,
  dismiss: Predicate.isFunction,
  setOverallCap: Predicate.isFunction
}

/** Whether `value` has every {@link Org} member: the reads as effects, the changes as functions. */
export const isOrg = (value: unknown): value is Org =>
  Object.entries(MEMBERS).every(
    ([member, check]) => Predicate.hasProperty(value, member) && check(value[member])
  )

/** The key the `org` plugin provides its {@link Org} under; import it to read the org typed. */
export const OrgService = ServiceKey.make('org', isOrg)

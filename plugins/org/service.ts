import { type AgentName, ServiceKey } from '@dia/plugin'
import type { AgentDefinitionRegistry } from '@dia-plugin/agent-definitions/registry'
import type { ProviderIssues } from '@dia-plugin/issues/service'
import { Effect, Predicate, type Scope, type Stream } from 'effect'
import type {
  BuiltInJobTitleDeleted,
  BuiltInJobTitleRenamed,
  HiredAgent,
  HireHasOpenIssues,
  HireId,
  HireNameTaken,
  HireNotFound,
  IssuesNotLoaded,
  JobTitle,
  JobTitleDisabled,
  JobTitleEdit,
  JobTitleHasHires,
  JobTitleId,
  JobTitleName,
  JobTitleNameTaken,
  JobTitleNotFound,
  JobTitleNotHireable,
  OrgSettings,
  OverallCap,
  ReportsToCycle,
  TeamPlan
} from './domain'

/**
 * The org (ADR-0033), as the `org` plugin provides it under {@link OrgService}. Reads return the
 * current state; each change returns the changed value. A job title's cap is the number of hired
 * agents of that job title. The job titles are the agent definitions of the registry
 * `holdDefinitions` holds (ADR-0072); with none held, `jobTitles` is empty and every job title
 * change fails with `JobTitleNotFound`. `jobTitles` lists the built-in job titles in seed order,
 * then the other definitions by name; `hiredAgents` lists by `hiredAt`, then creation order. A
 * database failure, or a failure to generate an id, is a defect.
 *
 * `watchJobTitleChanges` subscribes when run; the stream it returns emits once after each
 * `setJobTitleEnabled`, each change to the held registry's definitions, and each hold and release
 * of a registry since the subscription. `holdDefinitions` holds `registry` until the calling scope
 * closes; call it inside `whenProvided([AgentDefinitionRegistryKey], …)`. `watchHireChanges`
 * subscribes when run; the stream it returns emits once after each `hire`, `dismiss` and
 * `renameHire` since the subscription. `holdIssues` holds the issues assigned to the org's hired
 * agents until the calling scope closes; call it after registering the org as an assignee provider.
 *
 * `copyJobTitle` copies every field of `jobTitleId` into a new enabled job title named `name` that
 * is not built in. `editJobTitle` applies `edit`'s present fields. `deleteJobTitle` deletes a copy
 * with no hired agents. `hire` hires an agent of an enabled job title, named `name` or unnamed when
 * null, reporting to hired agent `reportsTo` or to the user when null. `dismiss` removes a hired
 * agent and moves its reports to its own `reportsTo`; it fails with `HireHasOpenIssues` while the
 * agent is assigned to an issue that is neither `done` nor `canceled`, and with `IssuesNotLoaded`
 * while no issues are held. `renameHire` names a hired agent `name`, or clears its name
 * when null; the name must be free among the other hired agents, ignoring ASCII case.
 * `setBypassOverride` sets a hired agent's bypass override: true or false overrides its job
 * title's `bypassOptIn`, null follows the job title (ADR-0054). `setReportsTo` makes a hired agent
 * report to hired agent `reportsTo`, or to the user when null; it fails with `ReportsToCycle` when
 * `reportsTo` is the agent or reports to it. A missing hire, checked before a missing `reportsTo`,
 * fails with `HireNotFound` naming its id.
 */
export interface Org {
  readonly jobTitles: Effect.Effect<ReadonlyArray<JobTitle>>
  readonly watchJobTitleChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  readonly holdDefinitions: (
    registry: AgentDefinitionRegistry
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly watchHireChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  readonly holdIssues: (issues: HeldIssues) => Effect.Effect<void, never, Scope.Scope>
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
    name: AgentName | null,
    reportsTo: HireId | null
  ) => Effect.Effect<
    HiredAgent,
    JobTitleNotFound | JobTitleDisabled | JobTitleNotHireable | HireNameTaken | HireNotFound
  >
  /**
   * Hires `plan` in one transaction: the lead reports to the user, and every member reports to the
   * lead, or to the user when there is no lead. Every hire is unnamed. Fails, hiring nobody, when
   * a job title is missing, disabled or the Executive assistant.
   */
  readonly staffTeam: (
    plan: TeamPlan
  ) => Effect.Effect<
    ReadonlyArray<HiredAgent>,
    JobTitleNotFound | JobTitleDisabled | JobTitleNotHireable
  >
  readonly dismiss: (
    hireId: HireId
  ) => Effect.Effect<void, HireNotFound | HireHasOpenIssues | IssuesNotLoaded>
  readonly renameHire: (
    hireId: HireId,
    name: AgentName | null
  ) => Effect.Effect<HiredAgent, HireNotFound | HireNameTaken>
  readonly setBypassOverride: (
    hireId: HireId,
    override: boolean | null
  ) => Effect.Effect<HiredAgent, HireNotFound>
  readonly setReportsTo: (
    hireId: HireId,
    reportsTo: HireId | null
  ) => Effect.Effect<HiredAgent, HireNotFound | ReportsToCycle>
  readonly setOverallCap: (cap: OverallCap) => Effect.Effect<OrgSettings>
}

/** What `Org.holdIssues` takes: the count of a hired agent's open issues. */
export type HeldIssues = Pick<ProviderIssues, 'countOpenIssues'>

const MEMBERS: Record<keyof Org, (member: unknown) => boolean> = {
  jobTitles: Effect.isEffect,
  watchJobTitleChanges: Effect.isEffect,
  holdDefinitions: Predicate.isFunction,
  watchHireChanges: Effect.isEffect,
  holdIssues: Predicate.isFunction,
  hiredAgents: Effect.isEffect,
  settings: Effect.isEffect,
  setJobTitleEnabled: Predicate.isFunction,
  copyJobTitle: Predicate.isFunction,
  editJobTitle: Predicate.isFunction,
  deleteJobTitle: Predicate.isFunction,
  hire: Predicate.isFunction,
  staffTeam: Predicate.isFunction,
  dismiss: Predicate.isFunction,
  renameHire: Predicate.isFunction,
  setBypassOverride: Predicate.isFunction,
  setReportsTo: Predicate.isFunction,
  setOverallCap: Predicate.isFunction
}

/** Whether `value` has every {@link Org} member: the reads as effects, the changes as functions. */
export const isOrg = (value: unknown): value is Org =>
  Object.entries(MEMBERS).every(
    ([member, check]) => Predicate.hasProperty(value, member) && check(value[member])
  )

/** The key the `org` plugin provides its {@link Org} under; import it to read the org typed. */
export const OrgService = ServiceKey.make('org', isOrg)

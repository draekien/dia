import { type DiaTool, ServiceKey, type SessionId } from '@dia/plugin'
import { type Array as Arr, Effect, Predicate, Schema, type Scope, type Stream } from 'effect'
import {
  type AssigneeGroup,
  type AssigneeNotFound,
  type AssigneeProviderTaken,
  type AssigneeRef,
  type FirstIssue,
  Issue,
  IssueComment,
  IssueId,
  type IssueNotAssignable,
  type IssueNotFound,
  type IssueNotInTriage,
  type IssueNotStarted,
  type IssuesSnapshot,
  type ListedAssignee,
  type NewObjective,
  type NewWorkIssue,
  Objective,
  ObjectiveId,
  type ObjectiveNotFound,
  type ProjectNotFound,
  type ProviderId,
  type Refusal,
  type TriageDecision
} from './domain'

/**
 * An assignee provider: its `id`, the `label` the Issues page shows, and `assignees`, the stream of
 * the assignees it lists, emitting the current list first and a new list after each change.
 */
export interface AssigneeProvider {
  readonly id: ProviderId
  readonly label: string
  readonly assignees: Stream.Stream<ReadonlyArray<ListedAssignee>>
}

/** A `todo` issue assigned to the provider, and its objective. */
export interface StartableIssue {
  readonly issue: Issue
  readonly objective: Objective
}

/** One event from another plugin's event log: its `seq` there, when it happened, and its text. */
export const ImportedEvent = Schema.Struct({
  seq: Schema.Int,
  at: Schema.Number,
  objectiveId: ObjectiveId,
  issueId: Schema.NullOr(IssueId),
  event: Schema.String
})
export type ImportedEvent = typeof ImportedEvent.Type

/** The objectives, issues, comments and events {@link Issues.importWork} adds. */
export const ImportedWork = Schema.Struct({
  objectives: Schema.Array(Objective),
  issues: Schema.Array(Issue),
  comments: Schema.Array(IssueComment),
  events: Schema.Array(ImportedEvent)
})
export type ImportedWork = typeof ImportedWork.Type

/**
 * The issues assigned to one provider, and the run transitions on them. Each transition changes
 * an issue only in the status it expects and only when its assignee's provider is this one, and
 * reports whether it did: `markStarted` moves a `todo` issue assigned to `assigneeId` to
 * `understanding`; `markSessionStarted` stores the session a started issue resumes next;
 * `markRequeued` moves a started issue other than `in_review` back to `todo`, keeping its session,
 * or clearing it when `keepSession` is false; `requeueRunning` does that, keeping the session, for
 * every such issue of the provider and returns how many it moved; `markRefused` moves a `todo`
 * issue to `triage` with `refusal`, so it waits for the user.
 */
export interface ProviderIssues {
  /** The `todo` issues assigned to this provider with their objectives, and its started issues. */
  readonly runState: Effect.Effect<{
    readonly startable: ReadonlyArray<StartableIssue>
    readonly started: ReadonlyArray<Issue>
  }>
  readonly markStarted: (issueId: IssueId, assigneeId: string) => Effect.Effect<boolean>
  readonly markSessionStarted: (issueId: IssueId, sessionId: SessionId) => Effect.Effect<boolean>
  readonly markRequeued: (issueId: IssueId, keepSession: boolean) => Effect.Effect<boolean>
  readonly requeueRunning: Effect.Effect<number>
  readonly markRefused: (issueId: IssueId, refusal: Refusal) => Effect.Effect<boolean>
  /** How many issues assigned to `assigneeId` are neither `done` nor `canceled`. */
  readonly countOpenIssues: (assigneeId: string) => Effect.Effect<number>
  /**
   * The agent issue tools (`create_issue`, `update_issue`, `comment_issue`) for a session working
   * on `issueId` as `assigneeId`: each acts only within that issue's objective, and comments are
   * authored by the assignee. Pass them as the session's dia tools.
   */
  readonly issueTools: (issueId: IssueId, assigneeId: string) => ReadonlyArray<DiaTool>
}

/**
 * The objectives, issues and comments, and the assignee providers that run them. Read it with
 * `ctx.whenProvided([IssuesKey], …)`. A database failure, or a failure to generate an id, is a
 * defect. `createIssue` reopens a completed objective and returns the stored issue for a repeated
 * `id`; `assignIssue` needs an issue in `triage` or `todo`, and giving an issue its current
 * assignee returns it unchanged in any status; `triageIssues` moves each `triage` issue to `todo`
 * (accept) or `canceled` (decline), leaves one already there unchanged, and fails the whole call
 * on any other status; `finishIssue` moves a started issue to `done` and creates nothing, and
 * returns a `done` issue unchanged; `stopObjective` cancels the objective's issues that are not
 * closed and returns them. An objective completes once it has issues and every one is closed.
 */
export interface Issues {
  readonly snapshot: Effect.Effect<IssuesSnapshot>
  /**
   * Subscribes when run; the stream emits once after each committed change to objectives, issues
   * or comments, and each provider registration, release or assignee list change.
   */
  readonly watchChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  /** The held providers by label, with the assignees each lists now. */
  readonly providers: Effect.Effect<ReadonlyArray<AssigneeGroup>>
  /**
   * Creates an open objective and `firstIssues` (each in `todo`, all in `input.id`, no
   * `parentIssueId`) in one transaction. A repeated `id` returns the stored objective and creates
   * nothing.
   */
  readonly createObjective: (
    input: NewObjective,
    firstIssues: ReadonlyArray<FirstIssue>
  ) => Effect.Effect<Objective, ProjectNotFound | AssigneeNotFound>
  readonly createIssue: (
    input: NewWorkIssue
  ) => Effect.Effect<Issue, ObjectiveNotFound | IssueNotFound | AssigneeNotFound>
  readonly assignIssue: (
    issueId: IssueId,
    assignee: AssigneeRef | null
  ) => Effect.Effect<Issue, IssueNotFound | IssueNotAssignable | AssigneeNotFound>
  readonly triageIssues: (
    issueIds: Arr.NonEmptyReadonlyArray<IssueId>,
    decision: TriageDecision
  ) => Effect.Effect<ReadonlyArray<Issue>, IssueNotFound | IssueNotInTriage>
  readonly finishIssue: (issueId: IssueId) => Effect.Effect<Issue, IssueNotFound | IssueNotStarted>
  readonly stopObjective: (
    objectiveId: ObjectiveId
  ) => Effect.Effect<ReadonlyArray<Issue>, ObjectiveNotFound>
  /**
   * Holds `provider` until the calling scope closes and returns the run API for the issues
   * assigned to it. Call it inside `whenProvided([IssuesKey], …)`. Returns after the provider's
   * first `assignees` emission is stored, so every assignee it lists is valid from the moment this
   * effect succeeds. A stream that ends before its first emission lists no assignees; after a
   * stream ends, its last list stands. When the scope closes, every started issue assigned to the
   * provider other than `in_review` returns to `todo`, keeping its session.
   */
  readonly registerProvider: (
    provider: AssigneeProvider
  ) => Effect.Effect<ProviderIssues, AssigneeProviderTaken, Scope.Scope>
  /**
   * Adds `work` taken from another plugin's store in one transaction, skipping every row already
   * stored, so running it again adds nothing. Only for a one-time move; it does not start or change
   * any issue.
   */
  readonly importWork: (work: ImportedWork) => Effect.Effect<void>
}

const MEMBERS: Record<keyof Issues, (member: unknown) => boolean> = {
  snapshot: Effect.isEffect,
  watchChanges: Effect.isEffect,
  providers: Effect.isEffect,
  createObjective: Predicate.isFunction,
  createIssue: Predicate.isFunction,
  assignIssue: Predicate.isFunction,
  triageIssues: Predicate.isFunction,
  finishIssue: Predicate.isFunction,
  stopObjective: Predicate.isFunction,
  registerProvider: Predicate.isFunction,
  importWork: Predicate.isFunction
}

/** Whether `value` has every {@link Issues} member: the reads as effects, the changes as functions. */
export const isIssues = (value: unknown): value is Issues =>
  Object.entries(MEMBERS).every(
    ([member, check]) => Predicate.hasProperty(value, member) && check(value[member])
  )

/** The key the `issues` plugin provides its {@link Issues} under: `issues`. */
export const IssuesKey = ServiceKey.make('issues', isIssues)

import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'
import {
  AssigneeGroup,
  AssigneeNotFound,
  AssigneeRef,
  Issue,
  IssueId,
  IssueNotAssignable,
  IssueNotFound,
  IssueNotInTriage,
  IssueNotStarted,
  IssuesSnapshot,
  NewObjective,
  NewWorkIssue,
  Objective,
  ObjectiveNotFound,
  ProjectNotFound,
  TriageDecision
} from './domain'

/** Every objective, issue and comment, and the assignees each held provider lists now. */
export const IssuesView = Schema.Struct({
  ...IssuesSnapshot.fields,
  providers: Schema.Array(AssigneeGroup)
})
export type IssuesView = typeof IssuesView.Type

/** Reads the {@link IssuesView}. */
export const ReadIssues = Rpc.make('ReadIssues', { payload: {}, success: IssuesView })

/**
 * Streams the {@link IssuesView}: the current one when subscribed, then a new one after each change
 * to objectives, issues, comments or providers. Several changes during one read give one more view,
 * so a subscriber always ends on the latest state.
 */
export const WatchIssues = Rpc.make('WatchIssues', {
  payload: {},
  success: IssuesView,
  stream: true
})

/**
 * Creates an open objective with no issues; a repeated call with the same `id` returns the stored
 * objective.
 */
export const CreateObjective = Rpc.make('CreateObjective', {
  payload: { objective: NewObjective },
  success: Objective,
  error: Schema.Union([ProjectNotFound, AssigneeNotFound])
})

/**
 * Creates a `work` issue in `todo`, reopening a completed objective; a repeated call with the same
 * `id` returns the stored issue.
 */
export const CreateIssue = Rpc.make('CreateIssue', {
  payload: { issue: NewWorkIssue },
  success: Issue,
  error: Schema.Union([ObjectiveNotFound, IssueNotFound, AssigneeNotFound])
})

/** Gives `triage` or `todo` issue `issueId` to `assignee`, or takes it from its assignee when null. */
export const AssignIssue = Rpc.make('AssignIssue', {
  payload: { issueId: IssueId, assignee: Schema.NullOr(AssigneeRef) },
  success: Issue,
  error: Schema.Union([IssueNotFound, IssueNotAssignable, AssigneeNotFound])
})

/**
 * Accepts (to `todo`) or declines (to `canceled`) every `triage` issue in `issueIds`, all or none;
 * an issue already in the decision's target is left as it is. Returns the issues in `issueIds`
 * order.
 */
export const TriageIssues = Rpc.make('TriageIssues', {
  payload: { issueIds: Schema.NonEmptyArray(IssueId), decision: TriageDecision },
  success: Schema.Array(Issue),
  error: Schema.Union([IssueNotFound, IssueNotInTriage])
})

/** Finishes started issue `issueId`: it becomes `done`, and its provider stops its session. */
export const FinishIssue = Rpc.make('FinishIssue', {
  payload: { issueId: IssueId },
  success: Issue,
  error: Schema.Union([IssueNotFound, IssueNotStarted])
})

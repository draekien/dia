import { Data, Either, Schema } from 'effect'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/**
 * An opaque permission-rule update owned by the Agent SDK. dia carries these
 * through unmodified: the SDK offers them as a `PermissionRequest`'s
 * `suggestions`, and the user's `Allow` echoes chosen ones back as
 * `updatedPermissions` to persist an "always allow" rule. dia never inspects
 * their internal shape.
 */
export const PermissionUpdate = JsonRecord
export type PermissionUpdate = typeof PermissionUpdate.Type

const QuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.String
})

/**
 * One clarifying question the agent posed via `AskUserQuestion`: the prompt
 * text, a short `header` label, its selectable `options`, and whether more than
 * one option may be chosen. Rendered by the pane's clarifying-question card and
 * echoed back inside a `QuestionResponse`.
 */
export const Question = Schema.Struct({
  question: Schema.String,
  header: Schema.String,
  options: Schema.Array(QuestionOption),
  multiSelect: Schema.Boolean
})
export type Question = typeof Question.Type

/**
 * A pending tool-permission ask surfaced by a pane, carrying enough detail
 * (request id, tool name, input) to render a prompt and correlate the user's
 * `PermissionResponse` back to the originating SDK request. `suggestions`, when
 * present, are the SDK's offered "always allow" rules for this kind of call.
 */
export const PermissionRequest = Schema.TaggedStruct('PermissionRequest', {
  requestId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord,
  suggestions: Schema.optional(Schema.Array(PermissionUpdate))
})
export type PermissionRequest = typeof PermissionRequest.Type

/**
 * A pending `AskUserQuestion` ask surfaced by a pane, carrying the SDK's
 * `questions` and the `requestId` used to correlate the user's
 * `QuestionResponse` back to the originating SDK request.
 */
export const ClarifyingQuestion = Schema.TaggedStruct('ClarifyingQuestion', {
  requestId: Schema.String,
  questions: Schema.Array(Question)
})
export type ClarifyingQuestion = typeof ClarifyingQuestion.Type

/**
 * A pending plan review surfaced by a pane running in `plan` mode, raised when
 * the agent calls `ExitPlanMode`. Carries the proposed `plan` text and the
 * `requestId` used to correlate the user's approve/reject decision back to the
 * originating SDK request.
 */
export const PlanReview = Schema.TaggedStruct('PlanReview', {
  requestId: Schema.String,
  plan: Schema.String
})
export type PlanReview = typeof PlanReview.Type

/**
 * What a pane in `AwaitingPermission` is blocked on: a tool `PermissionRequest`,
 * a `ClarifyingQuestion`, or a `PlanReview`. Branch on `_tag` to route to the
 * matching dialog and response command.
 */
export const UserInputRequest = Schema.Union(PermissionRequest, ClarifyingQuestion, PlanReview)
export type UserInputRequest = typeof UserInputRequest.Type

/**
 * The user allowing a `PermissionRequest`: the tool runs, with `updatedInput`
 * present only when the user edited it (absent means "as-is") and optional
 * `updatedPermissions` echoing an "always allow" suggestion back. Construct
 * with `Allow.make(...)`.
 */
export const Allow = Schema.TaggedStruct('Allow', {
  updatedInput: Schema.optional(JsonRecord),
  updatedPermissions: Schema.optional(Schema.Array(PermissionUpdate))
})
export type Allow = typeof Allow.Type

/**
 * The user denying a `PermissionRequest`: the tool is refused with a `message`
 * surfaced to the agent, not just the user. Construct with `Deny.make(...)`.
 */
export const Deny = Schema.TaggedStruct('Deny', {
  message: Schema.String
})
export type Deny = typeof Deny.Type

/**
 * The user's decision on a `PermissionRequest`: either an `Allow` or a `Deny`.
 * Branch on `_tag` to route the response.
 */
export const PermissionResponse = Schema.Union(Allow, Deny)
export type PermissionResponse = typeof PermissionResponse.Type

const AnswerValue = Schema.Union(Schema.String, Schema.Array(Schema.String))

/**
 * The user's per-question reply to a `ClarifyingQuestion`: the resolved choice
 * per question (a chosen label, a label array for `multiSelect`, or free text
 * typed in place of an option), echoed alongside the `questions` it answers.
 * Construct with `Answers.make(...)`.
 */
export const Answers = Schema.TaggedStruct('Answers', {
  questions: Schema.Array(Question),
  answers: Schema.Record({ key: Schema.String, value: AnswerValue })
})
export type Answers = typeof Answers.Type

/**
 * The user's reply to a `ClarifyingQuestion` when they dismissed the card and
 * typed a general reply instead of answering per question. Construct with
 * `FreeformResponse.make(...)`.
 */
export const FreeformResponse = Schema.TaggedStruct('FreeformResponse', {
  questions: Schema.Array(Question),
  response: Schema.String
})
export type FreeformResponse = typeof FreeformResponse.Type

/**
 * The user's reply to a `ClarifyingQuestion`: either per-question `Answers` or
 * a `FreeformResponse`. Branch on `_tag` to route the response.
 */
export const QuestionResponse = Schema.Union(Answers, FreeformResponse)
export type QuestionResponse = typeof QuestionResponse.Type

/**
 * The user's decision on a `PlanReview`: `approved` true lets the agent's
 * `ExitPlanMode` call proceed (and the pane's mode is restored to what it was
 * before entering plan); false keeps the pane planning. Construct with
 * `PlanReviewResponse.make(...)`.
 */
export const PlanReviewResponse = Schema.TaggedStruct('PlanReviewResponse', {
  approved: Schema.Boolean
})
export type PlanReviewResponse = typeof PlanReviewResponse.Type

/** A pane-level error message, used to describe why a pane entered `Errored`. */
export const PaneError = Schema.Struct({
  message: Schema.String
})
export type PaneError = typeof PaneError.Type

/** A pane with no outstanding attention needs. */
export const Idle = Schema.TaggedStruct('Idle', {})
/** A pane blocked on a `UserInputRequest` that the user has not yet resolved. */
export const AwaitingPermission = Schema.TaggedStruct('AwaitingPermission', {
  request: UserInputRequest
})
/**
 * A pane that has crashed or failed. This is terminal: see `validTransitions`
 * for why no transition leads back out of it.
 */
export const Errored = Schema.TaggedStruct('Errored', { error: PaneError })
/** A pane whose run finished; settles back to `Idle` after a timeout. */
export const Completed = Schema.TaggedStruct('Completed', {})

/**
 * The set of attention states a pane can be in. Use `transitionAttention`
 * rather than constructing transitions by hand so invalid moves are rejected.
 */
export const AttentionState = Schema.Union(Idle, AwaitingPermission, Errored, Completed)
export type AttentionState = typeof AttentionState.Type

/**
 * Raised by `transitionAttention` when the requested `from` -> `to` move is
 * not in the allowed state machine. Carries both tags for diagnostics.
 */
export class InvalidAttentionTransition extends Data.TaggedError('InvalidAttentionTransition')<{
  readonly from: AttentionState['_tag']
  readonly to: AttentionState['_tag']
}> {}

// Idle <-> AwaitingPermission (resolved), Idle <-> Completed (settles after a timeout), and
// Idle/AwaitingPermission/Completed -> Errored. Errored is terminal: there is no pure transition
// out of it -- a crashed/errored pane stays red until the user closes it.
const validTransitions: ReadonlySet<string> = new Set([
  'Idle->AwaitingPermission',
  'Idle->Errored',
  'Idle->Completed',
  'AwaitingPermission->Idle',
  'AwaitingPermission->Errored',
  'Completed->Idle',
  'Completed->Errored'
])

/**
 * Attempts to move a pane's attention state from `current` to `next`.
 * Returns the new state on success, or `InvalidAttentionTransition` if that
 * move isn't allowed. Call this instead of assigning `AttentionState`
 * directly so the pane's state machine can't be put into an invalid shape.
 */
export const transitionAttention = (
  current: AttentionState,
  next: AttentionState
): Either.Either<AttentionState, InvalidAttentionTransition> =>
  validTransitions.has(`${current._tag}->${next._tag}`)
    ? Either.right(next)
    : Either.left(new InvalidAttentionTransition({ from: current._tag, to: next._tag }))

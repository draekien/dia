import { Data, Either, Schema } from 'effect'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/**
 * A pending tool-permission ask surfaced by a pane, carrying enough detail
 * (request id, tool name, input) to render a prompt and correlate the
 * user's decision back to the originating SDK request.
 */
export const PermissionRequest = Schema.Struct({
  requestId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord
})
export type PermissionRequest = typeof PermissionRequest.Type

/** A pane-level error message, used to describe why a pane entered `Errored`. */
export const PaneError = Schema.Struct({
  message: Schema.String
})
export type PaneError = typeof PaneError.Type

/** A pane with no outstanding attention needs. */
export const Idle = Schema.TaggedStruct('Idle', {})
/** A pane blocked on a `PermissionRequest` that the user has not yet resolved. */
export const AwaitingPermission = Schema.TaggedStruct('AwaitingPermission', {
  request: PermissionRequest
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

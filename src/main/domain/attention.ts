import { Data, Either, Schema } from 'effect'

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export const PermissionRequest = Schema.Struct({
  requestId: Schema.String,
  toolName: Schema.String,
  input: JsonRecord
})
export type PermissionRequest = typeof PermissionRequest.Type

export const PaneError = Schema.Struct({
  message: Schema.String
})
export type PaneError = typeof PaneError.Type

export const Idle = Schema.TaggedStruct('Idle', {})
export const AwaitingPermission = Schema.TaggedStruct('AwaitingPermission', {
  request: PermissionRequest
})
export const Errored = Schema.TaggedStruct('Errored', { error: PaneError })
export const Completed = Schema.TaggedStruct('Completed', {})

export const AttentionState = Schema.Union(Idle, AwaitingPermission, Errored, Completed)
export type AttentionState = typeof AttentionState.Type

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

export const transitionAttention = (
  current: AttentionState,
  next: AttentionState
): Either.Either<AttentionState, InvalidAttentionTransition> =>
  validTransitions.has(`${current._tag}->${next._tag}`)
    ? Either.right(next)
    : Either.left(new InvalidAttentionTransition({ from: current._tag, to: next._tag }))

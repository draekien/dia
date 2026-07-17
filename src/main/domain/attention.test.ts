import { Either } from 'effect'
import { describe, expect, it } from 'vitest'
import { type AttentionState, InvalidAttentionTransition, transitionAttention } from './attention'

const idle: AttentionState = { _tag: 'Idle' }
const awaitingPermission: AttentionState = {
  _tag: 'AwaitingPermission',
  request: { _tag: 'PermissionRequest', requestId: 'req-1', toolName: 'Bash', input: {} }
}
const errored: AttentionState = { _tag: 'Errored', error: { message: 'boom' } }
const completed: AttentionState = { _tag: 'Completed' }

const states: ReadonlyArray<AttentionState> = [idle, awaitingPermission, errored, completed]

// Derived from the bullet doc's transition diagram (Idle -> AwaitingPermission -> Idle,
// Idle -> Errored, Idle -> Completed -> Idle) plus mvp.md §6: a crash can transition a pane to
// Errored at any point in a turn's lifecycle, not only from Idle, so AwaitingPermission/Completed
// -> Errored are also valid. Errored has no way out -- a crashed/errored pane stays red until the
// user closes it, so every pair with Errored as the "from" state must be rejected.
const validPairs: ReadonlySet<string> = new Set([
  'Idle->AwaitingPermission',
  'Idle->Errored',
  'Idle->Completed',
  'AwaitingPermission->Idle',
  'AwaitingPermission->Errored',
  'Completed->Idle',
  'Completed->Errored'
])

describe('transitionAttention', () => {
  for (const from of states) {
    for (const to of states) {
      const pair = `${from._tag}->${to._tag}`
      const isValid = validPairs.has(pair)

      it(`${isValid ? 'allows' : 'rejects'} ${pair}`, () => {
        const result = transitionAttention(from, to)

        if (isValid) {
          expect(result).toEqual(Either.right(to))
        } else {
          expect(Either.isLeft(result)).toBe(true)
          expect(result).toEqual(
            Either.left(new InvalidAttentionTransition({ from: from._tag, to: to._tag }))
          )
        }
      })
    }
  }
})

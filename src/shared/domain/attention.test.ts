import { Either, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  type AttentionState,
  InvalidAttentionTransition,
  PermissionResponse,
  type Question,
  QuestionResponse,
  transitionAttention
} from './attention'

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

const decodePermissionResponse = Schema.decodeUnknownEither(PermissionResponse)
const encodePermissionResponse = Schema.encodeSync(PermissionResponse)
const decodeQuestionResponse = Schema.decodeUnknownEither(QuestionResponse)
const encodeQuestionResponse = Schema.encodeSync(QuestionResponse)

const approach: Question = {
  question: 'Which approach should I take?',
  header: 'Approach',
  options: [
    { label: 'Rewrite', description: 'Start from scratch' },
    { label: 'Patch', description: 'Minimal change' }
  ],
  multiSelect: false
}
const files: Question = {
  question: 'Which files may I touch?',
  header: 'Files',
  options: [
    { label: 'a.ts', description: 'the entrypoint' },
    { label: 'b.ts', description: 'a helper' }
  ],
  multiSelect: true
}

describe('PermissionResponse schema', () => {
  it('round-trips Allow as-is with no updatedInput or updatedPermissions', () => {
    const wire = { _tag: 'Allow' }
    expect(encodePermissionResponse({ _tag: 'Allow' })).toEqual(wire)
    expect(decodePermissionResponse(wire)).toEqual(Either.right({ _tag: 'Allow' }))
  })

  it('round-trips Allow with edited input and a remembered permission', () => {
    const value = {
      _tag: 'Allow' as const,
      updatedInput: { command: 'ls -la' },
      updatedPermissions: [{ type: 'addRule', rule: 'Bash(ls:*)' }]
    }
    const wire = {
      _tag: 'Allow',
      updatedInput: { command: 'ls -la' },
      updatedPermissions: [{ type: 'addRule', rule: 'Bash(ls:*)' }]
    }
    expect(encodePermissionResponse(value)).toEqual(wire)
    expect(decodePermissionResponse(wire)).toEqual(Either.right(value))
  })

  it('round-trips Deny with a message', () => {
    const value = { _tag: 'Deny' as const, message: 'use rg instead' }
    expect(encodePermissionResponse(value)).toEqual(value)
    expect(decodePermissionResponse(value)).toEqual(Either.right(value))
  })

  it('rejects an unknown decision tag', () => {
    expect(Either.isLeft(decodePermissionResponse({ _tag: 'Maybe' }))).toBe(true)
  })
})

describe('QuestionResponse schema', () => {
  it('round-trips Answers with a single label, a multiSelect array, and free text', () => {
    const value = {
      _tag: 'Answers' as const,
      questions: [approach, files],
      answers: {
        Approach: 'Rewrite',
        Files: ['b.ts', 'src/custom-path.ts']
      }
    }
    expect(encodeQuestionResponse(value)).toEqual(value)
    expect(decodeQuestionResponse(value)).toEqual(Either.right(value))
  })

  it('round-trips FreeformResponse carrying the questions it answers', () => {
    const value = {
      _tag: 'FreeformResponse' as const,
      questions: [approach],
      response: 'None of these — refactor the module instead'
    }
    expect(encodeQuestionResponse(value)).toEqual(value)
    expect(decodeQuestionResponse(value)).toEqual(Either.right(value))
  })

  it('rejects a non-string, non-array answer value', () => {
    const wire = {
      _tag: 'Answers',
      questions: [approach],
      answers: { Approach: 42 }
    }
    expect(Either.isLeft(decodeQuestionResponse(wire))).toBe(true)
  })
})

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

import { Result, Schema } from 'effect'
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
const crashed: AttentionState = { _tag: 'Crashed', error: { message: 'process exited' } }
const completed: AttentionState = { _tag: 'Completed' }
const parkedToResume: AttentionState = {
  _tag: 'ParkedToResume',
  cause: { _tag: 'UsageLimit', resetsAt: 1000 },
  resumesAt: 6000
}
const parkedUntilReset: AttentionState = {
  _tag: 'ParkedUntilReset',
  cause: { _tag: 'UsageLimit', resetsAt: 1000 },
  resetsAt: 1000
}
const parkedForUser: AttentionState = { _tag: 'ParkedForUser', cause: { _tag: 'SignedOut' } }

const states: ReadonlyArray<AttentionState> = [
  idle,
  awaitingPermission,
  errored,
  crashed,
  completed,
  parkedToResume,
  parkedUntilReset,
  parkedForUser
]

// Derived from the bullet doc's transition diagram (Idle -> AwaitingPermission -> Idle,
// Idle -> Errored, Idle -> Completed -> Idle) plus mvp.md §6: a crash can transition a pane to
// Errored at any point in a turn's lifecycle, not only from Idle, so AwaitingPermission/Completed
// -> Errored are also valid. Errored -> Idle is the only way out: a retry or fresh send clears a
// recoverable error. Errored -> AwaitingPermission/Completed stay rejected (a cleared error must
// pass through Idle first). Idle -> Idle is a valid self-loop (send/interrupt from an idle pane).
// A crash can strike from any non-terminal state, so every non-Crashed state -> Crashed; Crashed
// is terminal, so every pair with Crashed as the "from" state must be rejected.
const validPairs: ReadonlySet<string> = new Set([
  'Idle->Idle',
  'Idle->AwaitingPermission',
  'Idle->Errored',
  'Idle->Completed',
  'Idle->Crashed',
  'AwaitingPermission->Idle',
  'AwaitingPermission->Errored',
  'AwaitingPermission->Crashed',
  'Completed->Idle',
  'Completed->Errored',
  'Completed->Crashed',
  'Errored->Idle',
  'Errored->Crashed',
  'Idle->ParkedToResume',
  'Idle->ParkedForUser',
  'AwaitingPermission->ParkedToResume',
  'AwaitingPermission->ParkedForUser',
  'Completed->ParkedToResume',
  'Completed->ParkedForUser',
  'ParkedToResume->Idle',
  'ParkedToResume->Crashed',
  'ParkedToResume->ParkedToResume',
  'ParkedToResume->ParkedForUser',
  'ParkedForUser->Idle',
  'ParkedForUser->Crashed',
  'ParkedForUser->ParkedToResume',
  'ParkedForUser->ParkedForUser',
  'Idle->ParkedUntilReset',
  'AwaitingPermission->ParkedUntilReset',
  'Completed->ParkedUntilReset',
  'ParkedUntilReset->Idle',
  'ParkedUntilReset->Crashed',
  'ParkedUntilReset->ParkedToResume',
  'ParkedUntilReset->ParkedUntilReset',
  'ParkedUntilReset->ParkedForUser',
  'ParkedToResume->ParkedUntilReset',
  'ParkedForUser->ParkedUntilReset'
])

const decodePermissionResponse = Schema.decodeUnknownResult(PermissionResponse)
const encodePermissionResponse = Schema.encodeSync(PermissionResponse)
const decodeQuestionResponse = Schema.decodeUnknownResult(QuestionResponse)
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
    expect(decodePermissionResponse(wire)).toEqual(Result.succeed({ _tag: 'Allow' }))
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
    expect(decodePermissionResponse(wire)).toEqual(Result.succeed(value))
  })

  it('round-trips Deny with a message', () => {
    const value = { _tag: 'Deny' as const, message: 'use rg instead' }
    expect(encodePermissionResponse(value)).toEqual(value)
    expect(decodePermissionResponse(value)).toEqual(Result.succeed(value))
  })

  it('rejects an unknown decision tag', () => {
    expect(Result.isFailure(decodePermissionResponse({ _tag: 'Maybe' }))).toBe(true)
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
    expect(decodeQuestionResponse(value)).toEqual(Result.succeed(value))
  })

  it('round-trips FreeformResponse carrying the questions it answers', () => {
    const value = {
      _tag: 'FreeformResponse' as const,
      questions: [approach],
      response: 'None of these — refactor the module instead'
    }
    expect(encodeQuestionResponse(value)).toEqual(value)
    expect(decodeQuestionResponse(value)).toEqual(Result.succeed(value))
  })

  it('rejects a non-string, non-array answer value', () => {
    const wire = {
      _tag: 'Answers',
      questions: [approach],
      answers: { Approach: 42 }
    }
    expect(Result.isFailure(decodeQuestionResponse(wire))).toBe(true)
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
          expect(result).toEqual(Result.succeed(to))
        } else {
          expect(Result.isFailure(result)).toBe(true)
          expect(result).toEqual(
            Result.fail(new InvalidAttentionTransition({ from: from._tag, to: to._tag }))
          )
        }
      })
    }
  }
})

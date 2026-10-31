import { describe, expect, it } from 'vitest'
import type { PaneMessage } from './pane-chat'
import {
  type RewindProgress,
  rewindFailureMessage,
  rewindRowState,
  rewindTargets
} from './pane-rewind'

const user = (id: string, extra: Partial<PaneMessage> = {}): PaneMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', content: `${id} prompt` }],
  ...extra
})
const assistant = (id: string): PaneMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', content: `${id} reply` }]
})
const notice = (id: string, extra: Partial<PaneMessage> = {}): PaneMessage => ({
  id,
  role: 'notice',
  parts: [{ type: 'text', content: 'Model → claude-opus-5-5' }],
  ...extra
})
const error = (id: string): PaneMessage => ({
  id,
  role: 'error',
  parts: [{ type: 'text', content: 'Agent session ended unexpectedly' }]
})

describe('rewindTargets', () => {
  it('maps the agent turn before a rewindable user turn to that turn’s checkpoint', () => {
    const messages = [
      user('u1', { checkpointUuid: 'cp-1' }),
      assistant('a1'),
      user('u2', { checkpointUuid: 'cp-2', resumeAnchorUuid: 'anchor-a1' }),
      assistant('a2')
    ]

    expect(rewindTargets(messages)).toEqual(
      new Map([['a1', { checkpointUuid: 'cp-2', resumeAnchorUuid: 'anchor-a1' }]])
    )
  })

  it('gives no target to the last agent turn or to the first user turn', () => {
    const messages = [user('u1', { checkpointUuid: 'cp-1' }), assistant('a1')]

    expect(rewindTargets(messages).size).toBe(0)
  })

  it('omits resumeAnchorUuid when the user turn has none', () => {
    const messages = [assistant('a1'), user('u2', { checkpointUuid: 'cp-2' })]

    expect(rewindTargets(messages).get('a1')).toEqual({ checkpointUuid: 'cp-2' })
  })

  it('skips a model notice and an error between the agent turn and the user turn', () => {
    const messages = [
      assistant('a1'),
      error('e1'),
      notice('n1'),
      user('u2', { checkpointUuid: 'cp-2', resumeAnchorUuid: 'anchor-a1' })
    ]

    expect(rewindTargets(messages).get('a1')).toEqual({
      checkpointUuid: 'cp-2',
      resumeAnchorUuid: 'anchor-a1'
    })
  })

  it('gives no target across a compaction notice', () => {
    const messages = [
      assistant('a1'),
      notice('n1', { compaction: { preTokens: 34_000, postTokens: 12_000 } }),
      user('u2', { checkpointUuid: 'cp-2', resumeAnchorUuid: 'anchor-a1' })
    ]

    expect(rewindTargets(messages).size).toBe(0)
  })

  it('gives no target for a user turn marked not rewindable or without a checkpoint', () => {
    const messages = [
      assistant('a1'),
      user('u2', { checkpointUuid: 'cp-2', rewindable: false }),
      assistant('a2'),
      user('u3')
    ]

    expect(rewindTargets(messages).size).toBe(0)
  })

  it('targets the first turn of a batch, not the later turns sent with it', () => {
    const messages = [
      assistant('a1'),
      user('u2', { checkpointUuid: 'cp-2', resumeAnchorUuid: 'anchor-a1' }),
      user('u3', { checkpointUuid: 'cp-3', resumeAnchorUuid: 'anchor-a1', rewindable: false })
    ]

    expect(rewindTargets(messages)).toEqual(
      new Map([['a1', { checkpointUuid: 'cp-2', resumeAnchorUuid: 'anchor-a1' }]])
    )
  })

  it('gives no target when the turn before had no reply', () => {
    const messages = [
      user('u1', { checkpointUuid: 'cp-1' }),
      error('e1'),
      user('u2', { checkpointUuid: 'cp-2' })
    ]

    expect(rewindTargets(messages).size).toBe(0)
  })
})

describe('rewindRowState', () => {
  const target = { checkpointUuid: 'cp-2' }

  it('is ready while no rewind runs', () => {
    expect(rewindRowState({ status: 'idle' }, target)).toEqual({ status: 'ready' })
  })

  it('shows the rewind on the row that started it', () => {
    const progress: RewindProgress = { status: 'rewinding', checkpointUuid: 'cp-2' }

    expect(rewindRowState(progress, target)).toEqual({ status: 'rewinding' })
  })

  it('blocks every other row while a rewind runs', () => {
    const progress: RewindProgress = { status: 'rewinding', checkpointUuid: 'cp-9' }

    expect(rewindRowState(progress, target)).toEqual({ status: 'blocked' })
  })

  it('shows a failure on the row that started it', () => {
    const progress: RewindProgress = {
      status: 'failed',
      checkpointUuid: 'cp-2',
      message: 'Rewind failed: the rewind was interrupted.'
    }

    expect(rewindRowState(progress, target)).toEqual({
      status: 'failed',
      message: 'Rewind failed: the rewind was interrupted.'
    })
  })

  it('leaves other rows ready while a failure shows', () => {
    const progress: RewindProgress = {
      status: 'failed',
      checkpointUuid: 'cp-9',
      message: 'Rewind failed: the rewind was interrupted.'
    }

    expect(rewindRowState(progress, target)).toEqual({ status: 'ready' })
  })
})

describe('rewindFailureMessage', () => {
  it.each([
    ['NoLiveSession', 'Rewind failed: the session is not running.'],
    ['TurnNotInTranscript', 'Rewind failed: this turn is no longer in the session transcript.'],
    ['FilesNotRewound', 'Rewind failed: the files could not be restored.'],
    [
      'ConversationNotBranched',
      'Rewind failed: files were restored, but the conversation could not be branched.'
    ],
    ['Interrupted', 'Rewind failed: the rewind was interrupted.']
  ] as const)('describes %s', (cause, message) => {
    expect(rewindFailureMessage(cause)).toBe(message)
  })

  it('shows the SDK’s explanation when the files could not be rewound', () => {
    expect(
      rewindFailureMessage('FilesNotRewound', 'No file checkpoint found for this message.')
    ).toBe('Rewind failed: No file checkpoint found for this message.')
  })
})

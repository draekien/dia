import { Attention, PaneEvents, SignedOut } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { Option } from 'effect'
import { Boundary, boundaryOf } from './boundaries'

const PANE = 'aaaaaaaa-0000-4000-8000-000000000001'

const attentionChanged = (attention: Attention.AttentionState) =>
  PaneEvents.PaneAttentionChanged.make({ paneId: PANE, attention })

const sent = (texts: ReadonlyArray<string>) =>
  PaneEvents.PaneUserMessagesSent.make({
    paneId: PANE,
    messages: texts.map((text, index) => ({ id: `m${index}`, text }))
  })

describe('boundaryOf', () => {
  it('starts a turn with the first non-empty line of the first message', () => {
    assert.deepStrictEqual(
      boundaryOf(sent(['\n  Fix the build  \nthen test', 'second'])),
      Option.some(Boundary.TurnStart({ prompt: 'Fix the build' }))
    )
  })

  it('cuts a long prompt to 120 characters', () => {
    assert.deepStrictEqual(
      boundaryOf(sent(['x'.repeat(121)])),
      Option.some(Boundary.TurnStart({ prompt: 'x'.repeat(120) }))
    )
  })

  it('ends a turn when the run completes, errors or crashes', () => {
    const ends = [
      Attention.Completed.make({}),
      Attention.Errored.make({ error: { message: 'x' } }),
      Attention.Crashed.make({ error: { message: 'x' } })
    ].map((attention) => boundaryOf(attentionChanged(attention)))

    assert.deepStrictEqual(ends, [
      Option.some(Boundary.TurnEnd()),
      Option.some(Boundary.TurnEnd()),
      Option.some(Boundary.TurnEnd())
    ])
  })

  it('ends a turn when the run is parked', () => {
    assert.deepStrictEqual(
      boundaryOf(attentionChanged(Attention.ParkedForUser.make({ cause: SignedOut.make({}) }))),
      Option.some(Boundary.TurnEnd())
    )
  })

  it('does not end a turn when the run goes idle or waits for the user', () => {
    const request = Attention.PermissionRequest.make({
      requestId: 'p1',
      toolName: 'Bash',
      input: {}
    })

    assert.deepStrictEqual(
      [
        boundaryOf(attentionChanged(Attention.Idle.make({}))),
        boundaryOf(attentionChanged(Attention.AwaitingPermission.make({ request })))
      ],
      [Option.none(), Option.none()]
    )
  })

  it('reads no boundary from other run events', () => {
    assert.deepStrictEqual(
      boundaryOf(PaneEvents.PaneTurnStatusChanged.make({ paneId: PANE, label: 'Thinking' })),
      Option.none()
    )
  })
})

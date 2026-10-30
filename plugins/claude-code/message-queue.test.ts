import { describe, expect, it } from 'vitest'
import {
  DispatchAction,
  dispatchEnded,
  edit,
  InterruptAction,
  initialQueueState,
  QueueChangedAction,
  QueueIdle,
  QueueRunning,
  remove,
  resume,
  rewound,
  send,
  sessionEnded,
  stopRequested,
  turnEnded
} from './message-queue'

const a = { id: 'm-a', text: 'first' }
const b = { id: 'm-b', text: 'second' }
const c = { id: 'm-c', text: 'third' }

const runningWith = (changes: Partial<typeof QueueRunning.Type> = {}) =>
  QueueRunning.make({ queued: [], held: false, steered: [], dispatching: 0, ...changes })

describe('send', () => {
  it('dispatches a message at once when no turn is running, in either mode', () => {
    for (const mode of ['queue', 'steer'] as const) {
      const [actions, next] = send(a, mode)(initialQueueState)
      expect(actions).toEqual([DispatchAction.make({ messages: [a] })])
      expect(next).toEqual(runningWith({ dispatching: 1 }))
    }
  })

  it('dispatches a held queue ahead of the new message and reports the queue empty', () => {
    const [actions, next] = send(c, 'queue')(QueueIdle.make({ queued: [a, b], held: true }))
    expect(actions).toEqual([
      QueueChangedAction.make({ queued: [], held: false }),
      DispatchAction.make({ messages: [a, b, c] })
    ])
    expect(next).toEqual(runningWith({ dispatching: 1 }))
  })

  it('appends to the queue during a turn without interrupting it', () => {
    const [actions, next] = send(b, 'queue')(runningWith({ queued: [a] }))
    expect(actions).toEqual([QueueChangedAction.make({ queued: [a, b], held: false })])
    expect(next).toEqual(runningWith({ queued: [a, b] }))
  })

  it('releases a held queue when queueing during a turn, so it drains when the turn ends', () => {
    const [actions, next] = send(b, 'queue')(runningWith({ queued: [a], held: true }))
    expect(actions).toEqual([QueueChangedAction.make({ queued: [a, b], held: false })])
    expect(next).toEqual(runningWith({ queued: [a, b] }))
  })

  it('interrupts the turn and keeps the queue when steering', () => {
    const [actions, next] = send(b, 'steer')(runningWith({ queued: [a] }))
    expect(actions).toEqual([InterruptAction.make({})])
    expect(next).toEqual(runningWith({ queued: [a], steered: [b] }))
  })

  it('queues a steer that arrives after the turn ended but before the next batch is offered', () => {
    const [actions, next] = send(b, 'steer')(runningWith({ queued: [a], dispatching: 1 }))
    expect(actions).toEqual([QueueChangedAction.make({ queued: [a, b], held: false })])
    expect(next).toEqual(runningWith({ queued: [a, b], dispatching: 1 }))
  })

  it('does not interrupt twice when a second steer arrives before the turn ends', () => {
    const [actions, next] = send(c, 'steer')(runningWith({ steered: [b] }))
    expect(actions).toEqual([])
    expect(next).toEqual(runningWith({ steered: [b, c] }))
  })

  it('releases a held queue when steering, so it drains after the steer turn', () => {
    const [actions, next] = send(b, 'steer')(runningWith({ queued: [a], held: true }))
    expect(actions).toEqual([
      InterruptAction.make({}),
      QueueChangedAction.make({ queued: [a], held: false })
    ])
    expect(next).toEqual(runningWith({ queued: [a], steered: [b] }))
  })
})

describe('turnEnded', () => {
  it('dispatches steered messages alone and leaves the queue for the turn after', () => {
    const [actions, next] = turnEnded(true)(runningWith({ queued: [a], steered: [b] }))
    expect(actions).toEqual([DispatchAction.make({ messages: [b] })])
    expect(next).toEqual(runningWith({ queued: [a], dispatching: 1 }))
  })

  it('dispatches the whole queue as one turn, in order, and reports it empty', () => {
    const [actions, next] = turnEnded(true)(runningWith({ queued: [a, b, c] }))
    expect(actions).toEqual([
      QueueChangedAction.make({ queued: [], held: false }),
      DispatchAction.make({ messages: [a, b, c] })
    ])
    expect(next).toEqual(runningWith({ dispatching: 1 }))
  })

  it('holds the queue after a failed turn', () => {
    const [actions, next] = turnEnded(false)(runningWith({ queued: [a] }))
    expect(actions).toEqual([QueueChangedAction.make({ queued: [a], held: true })])
    expect(next).toEqual(QueueIdle.make({ queued: [a], held: true }))
  })

  it('keeps a held queue held when the turn completes', () => {
    const [actions, next] = turnEnded(true)(runningWith({ queued: [a], held: true }))
    expect(actions).toEqual([])
    expect(next).toEqual(QueueIdle.make({ queued: [a], held: true }))
  })

  it('goes idle with nothing to send', () => {
    expect(turnEnded(true)(runningWith())).toEqual([[], initialQueueState])
  })

  it('ignores a turn the CLI started while idle', () => {
    const state = QueueIdle.make({ queued: [a], held: true })
    expect(turnEnded(true)(state)).toEqual([[], state])
  })
})

describe('stopRequested', () => {
  it('interrupts and leaves the queue to run when the interrupted turn ends', () => {
    const [actions, next] = stopRequested(runningWith({ queued: [a] }))
    expect(actions).toEqual([InterruptAction.make({})])
    expect(next).toEqual(runningWith({ queued: [a] }))
  })

  it('moves steered messages to the front of the queue', () => {
    const [actions, next] = stopRequested(runningWith({ queued: [a], steered: [b] }))
    expect(actions).toEqual([
      InterruptAction.make({}),
      QueueChangedAction.make({ queued: [b, a], held: false })
    ])
    expect(next).toEqual(runningWith({ queued: [b, a] }))
  })

  it('releases a held queue', () => {
    const [actions, next] = stopRequested(runningWith({ queued: [a], held: true }))
    expect(actions).toEqual([
      InterruptAction.make({}),
      QueueChangedAction.make({ queued: [a], held: false })
    ])
    expect(next).toEqual(runningWith({ queued: [a] }))
  })

  it('sends the queue as one turn once the interrupted turn ends', () => {
    const [, stopped] = stopRequested(runningWith({ queued: [a], steered: [b] }))
    const [actions] = turnEnded(true)(stopped)
    expect(actions).toContainEqual(DispatchAction.make({ messages: [b, a] }))
  })

  it('only interrupts when nothing waits', () => {
    expect(stopRequested(runningWith())).toEqual([[InterruptAction.make({})], runningWith()])
  })

  it('still interrupts while idle, for a turn the CLI started', () => {
    expect(stopRequested(initialQueueState)).toEqual([
      [InterruptAction.make({})],
      initialQueueState
    ])
  })
})

describe('edit and remove', () => {
  it('replaces the text of a queued message', () => {
    const [actions, next] = edit(a.id, 'changed')(runningWith({ queued: [a, b] }))
    const queued = [{ id: a.id, text: 'changed' }, b]
    expect(actions).toEqual([QueueChangedAction.make({ queued, held: false })])
    expect(next).toEqual(runningWith({ queued }))
  })

  it('removes a queued message', () => {
    const [actions, next] = remove(a.id)(runningWith({ queued: [a, b] }))
    expect(actions).toEqual([QueueChangedAction.make({ queued: [b], held: false })])
    expect(next).toEqual(runningWith({ queued: [b] }))
  })

  it('clears the hold when the last held message is removed', () => {
    const [actions, next] = remove(a.id)(QueueIdle.make({ queued: [a], held: true }))
    expect(actions).toEqual([QueueChangedAction.make({ queued: [], held: false })])
    expect(next).toEqual(initialQueueState)
  })

  it('reports the current queue unchanged for a message that was already sent', () => {
    const state = runningWith({ queued: [b] })
    expect(edit(a.id, 'late')(state)).toEqual([
      [QueueChangedAction.make({ queued: [b], held: false })],
      state
    ])
    expect(remove(a.id)(state)).toEqual([
      [QueueChangedAction.make({ queued: [b], held: false })],
      state
    ])
  })
})

describe('rewound', () => {
  it('goes idle and holds the queue with steered messages in front', () => {
    const [actions, next] = rewound(runningWith({ queued: [a], steered: [b] }))
    expect(actions).toEqual([QueueChangedAction.make({ queued: [b, a], held: true })])
    expect(next).toEqual(QueueIdle.make({ queued: [b, a], held: true }))
  })

  it('stays running while a dispatch has not offered its messages', () => {
    const [, next] = rewound(runningWith({ dispatching: 1 }))
    expect(next).toEqual(runningWith({ dispatching: 1 }))
  })
})

describe('dispatchEnded', () => {
  it('counts down pending dispatches', () => {
    expect(dispatchEnded(runningWith({ dispatching: 2 }))).toEqual([
      [],
      runningWith({ dispatching: 1 })
    ])
  })
})

describe('sessionEnded', () => {
  it('empties the queue and reports it', () => {
    expect(sessionEnded(runningWith({ queued: [a], steered: [b] }))).toEqual([
      [QueueChangedAction.make({ queued: [], held: false })],
      initialQueueState
    ])
  })
})

describe('resume', () => {
  const resumeMessage = { id: 'm-r', text: 'continue' }

  it('dispatches the resume message ahead of a held queue and releases the queue', () => {
    const [actions, next] = resume(resumeMessage)(QueueIdle.make({ queued: [a, b], held: true }))
    expect(actions).toEqual([
      QueueChangedAction.make({ queued: [a, b], held: false }),
      DispatchAction.make({ messages: [resumeMessage] })
    ])
    expect(next).toEqual(runningWith({ queued: [a, b], dispatching: 1 }))
  })

  it('sends the released queue once the resumed turn ends', () => {
    const [, resumed] = resume(resumeMessage)(QueueIdle.make({ queued: [a], held: true }))
    const [, dispatched] = dispatchEnded(resumed)
    const [actions] = turnEnded(true)(dispatched)
    expect(actions).toEqual([
      QueueChangedAction.make({ queued: [], held: false }),
      DispatchAction.make({ messages: [a] })
    ])
  })

  it('dispatches the resume message alone when nothing is queued', () => {
    const [actions, next] = resume(resumeMessage)(initialQueueState)
    expect(actions).toEqual([DispatchAction.make({ messages: [resumeMessage] })])
    expect(next).toEqual(runningWith({ dispatching: 1 }))
  })

  it('does nothing while a turn is running', () => {
    const state = runningWith({ queued: [a] })
    expect(resume(resumeMessage)(state)).toEqual([[], state])
  })
})

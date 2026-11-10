import { IssueId, type ObjectivePriority } from '@dia-plugin/issues/domain'
import { describe, expect, it } from 'vitest'
import { HireId, OverallCap } from './domain'
import { nextStarts, type StartCandidate } from './scheduler'

const issue = (n: number) =>
  IssueId.make(`00000000-0000-4000-8000-3000000000${String(n).padStart(2, '0')}`)
const hire = (n: number) =>
  HireId.make(`00000000-0000-4000-8000-2000000000${String(n).padStart(2, '0')}`)

const candidate = (
  n: number,
  hireN: number,
  priority: ObjectivePriority = 'normal',
  createdAt = n
): StartCandidate => ({ issueId: issue(n), hireId: hire(hireN), priority, createdAt })

const pass = (overrides: {
  cap?: number
  heldSlots?: number
  busy?: ReadonlyArray<number>
  answered?: ReadonlyArray<number>
  waiting?: ReadonlyArray<StartCandidate>
}) =>
  nextStarts({
    overallCap: OverallCap.make(overrides.cap ?? 2),
    heldSlots: overrides.heldSlots ?? 0,
    busyHires: new Set((overrides.busy ?? []).map(hire)),
    answered: (overrides.answered ?? []).map(issue),
    waiting: overrides.waiting ?? []
  })

describe('nextStarts', () => {
  it('starts no more issues than the overall cap has free slots', () => {
    const waiting = [candidate(1, 1), candidate(2, 2), candidate(3, 3)]

    expect(pass({ cap: 2, heldSlots: 1, waiting }).start).toEqual([issue(1)])
  })

  it('starts nothing when the held slots already exceed the cap', () => {
    expect(pass({ cap: 2, heldSlots: 3, waiting: [candidate(1, 1)] }).start).toEqual([])
  })

  it('orders starts by objective priority before age', () => {
    const waiting = [
      candidate(1, 1, 'low', 1),
      candidate(2, 2, 'high', 9),
      candidate(3, 3, 'normal', 5)
    ]

    expect(pass({ cap: 3, waiting }).start).toEqual([issue(2), issue(3), issue(1)])
  })

  it('orders issues of one priority oldest first', () => {
    const waiting = [candidate(1, 1, 'normal', 30), candidate(2, 2, 'normal', 10)]

    expect(pass({ cap: 1, waiting }).start).toEqual([issue(2)])
  })

  it('starts at most one issue per hired agent in a pass', () => {
    const waiting = [candidate(1, 1), candidate(2, 1), candidate(3, 2)]

    expect(pass({ cap: 3, waiting }).start).toEqual([issue(1), issue(3)])
  })

  it('starts nothing for a hired agent that already has a started issue', () => {
    expect(pass({ cap: 3, busy: [1], waiting: [candidate(1, 1), candidate(2, 2)] }).start).toEqual([
      issue(2)
    ])
  })

  it('resumes an answered issue with every slot held, up to one over the cap', () => {
    expect(pass({ cap: 2, heldSlots: 2, answered: [7, 8] }).resume).toEqual([issue(7)])
  })

  it('resumes answered issues before starting todo ones', () => {
    const picked = pass({ cap: 2, heldSlots: 1, answered: [7], waiting: [candidate(1, 1)] })

    expect(picked).toEqual({ resume: [issue(7)], start: [] })
  })

  it('resumes nothing once the held slots are one over the cap', () => {
    expect(pass({ cap: 2, heldSlots: 3, answered: [7] }).resume).toEqual([])
  })
})

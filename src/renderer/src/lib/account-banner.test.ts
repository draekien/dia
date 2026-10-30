import {
  type AgentSummary,
  NoActivity,
  StatusNeedsInput,
  StatusParked,
  StatusWorking
} from '@shared/domain/agent-summary'
import type { ParkCause } from '@shared/domain/parking'
import { describe, expect, it } from 'vitest'
import { accountBannerOf, awaitsUser } from './account-banner'

const NOW = 10_000

const summary = (paneId: string, fields: Partial<AgentSummary> = {}): AgentSummary => ({
  paneId,
  status: StatusWorking.make({}),
  activity: NoActivity.make({}),
  ...fields
})

const parkedForUser = (paneId: string, cause: ParkCause) =>
  summary(paneId, { status: StatusNeedsInput.make({ reason: 'x' }), parked: cause })

const limit = (resetsAt: number | null): ParkCause => ({ _tag: 'UsageLimit', resetsAt })

const waitingToResume = (paneId: string, resumesAt: number) =>
  summary(paneId, { status: StatusParked.make({ resumesAt }), parked: limit(resumesAt - 5000) })

describe('awaitsUser', () => {
  it('is true for a signed-out agent', () => {
    expect(awaitsUser(parkedForUser('a', { _tag: 'SignedOut' }), NOW)).toBe(true)
  })

  it('is true once the reset time has passed, including the reset instant', () => {
    expect(awaitsUser(parkedForUser('a', limit(NOW)), NOW)).toBe(true)
    expect(awaitsUser(parkedForUser('a', limit(NOW - 1)), NOW)).toBe(true)
  })

  it('is false while the reset is still ahead', () => {
    expect(awaitsUser(parkedForUser('a', limit(NOW + 1)), NOW)).toBe(false)
  })

  it('is true when the reset time is unknown', () => {
    expect(awaitsUser(parkedForUser('a', limit(null)), NOW)).toBe(true)
  })

  it('is false for an agent dia resumes on its own', () => {
    expect(awaitsUser(waitingToResume('a', NOW - 1), NOW)).toBe(false)
  })

  it('is false for an agent that is not parked', () => {
    expect(awaitsUser(summary('a', { status: StatusNeedsInput.make({ reason: 'x' }) }), NOW)).toBe(
      false
    )
  })
})

describe('accountBannerOf', () => {
  it('shows nothing when no agent is parked', () => {
    expect(accountBannerOf([summary('a')], NOW)).toBeNull()
  })

  it('puts a signed-out agent ahead of every usage-limit banner, listing only signed-out agents', () => {
    expect(
      accountBannerOf(
        [parkedForUser('a', limit(NOW - 1)), parkedForUser('b', { _tag: 'SignedOut' })],
        NOW
      )
    ).toEqual({ _tag: 'SignedOutBanner', paneIds: ['b'] })
  })

  it('offers Resume all for the agents whose limit has reset', () => {
    expect(
      accountBannerOf(
        [
          parkedForUser('a', limit(NOW - 1)),
          parkedForUser('b', limit(NOW + 1)),
          parkedForUser('c', limit(null))
        ],
        NOW
      )
    ).toEqual({ _tag: 'LimitResetBanner', paneIds: ['a'] })
  })

  it('offers Resume all for agents with no known reset time ahead of waiting ones', () => {
    expect(
      accountBannerOf([parkedForUser('b', limit(NOW + 1)), parkedForUser('c', limit(null))], NOW)
    ).toEqual({ _tag: 'LimitUnknownBanner', paneIds: ['c'] })
  })

  it('names the earliest reset among agents waiting for the user', () => {
    expect(
      accountBannerOf(
        [
          parkedForUser('a', limit(NOW + 500)),
          parkedForUser('b', limit(NOW + 100)),
          waitingToResume('c', NOW + 50)
        ],
        NOW
      )
    ).toEqual({ _tag: 'LimitWaitingBanner', resetsAt: NOW + 100 })
  })

  it('names the earliest resume time when every parked agent resumes on its own', () => {
    expect(
      accountBannerOf([waitingToResume('a', NOW + 900), waitingToResume('b', NOW + 300)], NOW)
    ).toEqual({ _tag: 'LimitResumingBanner', resumesAt: NOW + 300 })
  })
})

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

const limit = (resetsAt: number | null): ParkCause => ({ _tag: 'UsageLimit', resetsAt })

const parkedForUser = (paneId: string, cause: ParkCause) =>
  summary(paneId, { status: StatusNeedsInput.make({ reason: 'x' }), parked: cause })

const waitingForReset = (paneId: string, resetsAt: number) =>
  summary(paneId, {
    status: StatusParked.make({ until: resetsAt, resumedBy: 'user' }),
    parked: limit(resetsAt)
  })

const resumingByDia = (paneId: string, resumesAt: number) =>
  summary(paneId, {
    status: StatusParked.make({ until: resumesAt, resumedBy: 'dia' }),
    parked: limit(resumesAt - 5000)
  })

describe('awaitsUser', () => {
  it('is true for a parked agent that needs input', () => {
    expect(awaitsUser(parkedForUser('a', { _tag: 'SignedOut' }))).toBe(true)
    expect(awaitsUser(parkedForUser('a', limit(NOW - 1)))).toBe(true)
  })

  it('is false while the agent waits for its reset', () => {
    expect(awaitsUser(waitingForReset('a', NOW + 1))).toBe(false)
  })

  it('is false for an agent dia resumes on its own', () => {
    expect(awaitsUser(resumingByDia('a', NOW + 1))).toBe(false)
  })

  it('is false for an agent that needs input but is not parked', () => {
    expect(awaitsUser(summary('a', { status: StatusNeedsInput.make({ reason: 'x' }) }))).toBe(false)
  })
})

describe('accountBannerOf', () => {
  it('shows nothing when no agent is parked', () => {
    expect(accountBannerOf([summary('a')])).toBeNull()
  })

  it('puts a signed-out agent ahead of every usage-limit banner, listing only signed-out agents', () => {
    expect(
      accountBannerOf([
        parkedForUser('a', limit(NOW - 1)),
        parkedForUser('b', { _tag: 'SignedOut' })
      ])
    ).toEqual({ _tag: 'SignedOutBanner', paneIds: ['b'] })
  })

  it('offers Resume all for the agents whose limit has reset', () => {
    expect(
      accountBannerOf([
        parkedForUser('a', limit(NOW - 1)),
        waitingForReset('b', NOW + 1),
        parkedForUser('c', limit(null))
      ])
    ).toEqual({ _tag: 'LimitResetBanner', paneIds: ['a'] })
  })

  it('offers Resume all for agents with no known reset time ahead of waiting ones', () => {
    expect(
      accountBannerOf([waitingForReset('b', NOW + 1), parkedForUser('c', limit(null))])
    ).toEqual({ _tag: 'LimitUnknownBanner', paneIds: ['c'] })
  })

  it('counts the agents waiting for a reset and names the earliest, ahead of agents dia resumes', () => {
    expect(
      accountBannerOf([
        waitingForReset('a', NOW + 500),
        waitingForReset('b', NOW + 100),
        resumingByDia('c', NOW + 50)
      ])
    ).toEqual({ _tag: 'LimitWaitingBanner', resetsAt: NOW + 100, count: 2 })
  })

  it('counts the agents dia resumes and names the earliest resume time', () => {
    expect(accountBannerOf([resumingByDia('a', NOW + 900), resumingByDia('b', NOW + 300)])).toEqual(
      { _tag: 'LimitResumingBanner', resumesAt: NOW + 300, count: 2 }
    )
  })
})

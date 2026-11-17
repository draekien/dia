import { describe, expect, it } from 'vitest'
import type { PullRequestCheck } from './calls'
import { failedPullRequest, readingPullRequest, readPullRequest } from './pull-requests.fake'
import { cardLines, checksSummary } from './summary'

const check = (state: PullRequestCheck['state']): PullRequestCheck => ({ name: state, state })

describe('checksSummary', () => {
  it.each([
    { case: 'no checks', checks: [] },
    { case: 'only skipped checks', checks: [check('skipped'), check('skipped')] }
  ])('says nothing for $case', ({ checks }) => {
    expect(checksSummary(checks)).toBeUndefined()
  })

  it('counts one failing check in the singular, over pending and passing ones', () => {
    expect(checksSummary([check('passed'), check('failed'), check('pending')])).toBe(
      '1 check failing'
    )
  })

  it('counts several failing checks in the plural', () => {
    expect(checksSummary([check('failed'), check('passed'), check('failed')])).toBe(
      '2 checks failing'
    )
  })

  it('reports pending over passing when none failed', () => {
    expect(checksSummary([check('passed'), check('pending')])).toBe('checks pending')
  })

  it('reports passing when every check passed or was skipped', () => {
    expect(checksSummary([check('passed'), check('skipped')])).toBe('checks passing')
  })
})

describe('cardLines', () => {
  it('shows the number and repository while the pull request is read', () => {
    expect(cardLines(readingPullRequest(295))).toEqual({ name: '#295', detail: 'draekien/dia' })
  })

  it('shows the number and the failure when the read failed', () => {
    expect(cardLines(failedPullRequest(295, 'GitHub CLI timed out'))).toEqual({
      name: '#295',
      detail: 'GitHub CLI timed out'
    })
  })

  it('shows the title, the state and the checks of an open pull request', () => {
    const linked = readPullRequest(295, { title: 'Link pull requests', checks: [check('failed')] })
    expect(cardLines(linked)).toEqual({
      name: '#295 Link pull requests',
      detail: 'Open, 1 check failing'
    })
  })

  it('shows the checks of a draft', () => {
    const linked = readPullRequest(295, { state: 'draft', checks: [check('pending')] })
    expect(cardLines(linked).detail).toBe('Draft, checks pending')
  })

  it.each([
    { state: 'merged', label: 'Merged' },
    { state: 'closed', label: 'Closed' }
  ] as const)('shows only the state of a $state pull request', ({ state, label }) => {
    const linked = readPullRequest(295, { state, checks: [check('failed')] })
    expect(cardLines(linked).detail).toBe(label)
  })

  it('shows only the state of an open pull request with no checks', () => {
    expect(cardLines(readPullRequest(295)).detail).toBe('Open')
  })
})

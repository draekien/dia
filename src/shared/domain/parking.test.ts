import { describe, expect, it } from 'vitest'
import { resumesAtFor, SignedOut, UsageLimit } from './parking'

const NOW = 1_000_000
const GRACE_MS = 5000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

const limitResettingAt = (resetsAt: number | null) => UsageLimit.make({ resetsAt })

describe('resumesAtFor', () => {
  it('resumes five seconds after a future reset under automatic', () => {
    expect(resumesAtFor(limitResettingAt(NOW + 60_000), 'automatic', NOW)).toBe(
      NOW + 60_000 + GRACE_MS
    )
  })

  it('waits for the user under manual', () => {
    expect(resumesAtFor(limitResettingAt(NOW + 60_000), 'manual', NOW)).toBeNull()
  })

  it('waits for the user when signed out', () => {
    expect(resumesAtFor(SignedOut.make({}), 'automatic', NOW)).toBeNull()
  })

  it('waits for the user when the reset time is unknown', () => {
    expect(resumesAtFor(limitResettingAt(null), 'automatic', NOW)).toBeNull()
  })

  it('waits for the user when the reset is now or already past', () => {
    expect(resumesAtFor(limitResettingAt(NOW), 'automatic', NOW)).toBeNull()
    expect(resumesAtFor(limitResettingAt(NOW - 1), 'automatic', NOW)).toBeNull()
  })

  it('resumes a reset one millisecond ahead', () => {
    expect(resumesAtFor(limitResettingAt(NOW + 1), 'automatic', NOW)).toBe(NOW + 1 + GRACE_MS)
  })

  it('resumes when the resume time is exactly seven days ahead', () => {
    const resetsAt = NOW + SEVEN_DAYS_MS - GRACE_MS
    expect(resumesAtFor(limitResettingAt(resetsAt), 'automatic', NOW)).toBe(NOW + SEVEN_DAYS_MS)
  })

  it('waits for the user when the resume time is more than seven days ahead', () => {
    const resetsAt = NOW + SEVEN_DAYS_MS - GRACE_MS + 1
    expect(resumesAtFor(limitResettingAt(resetsAt), 'automatic', NOW)).toBeNull()
  })
})

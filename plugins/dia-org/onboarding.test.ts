import { describe, expect, it } from 'vitest'
import { onboardingStage } from './onboarding'

describe('onboardingStage', () => {
  it.each([
    ['no project, no hire', 0, 0, false, 'add-project'],
    ['no project, with hires that have work', 0, 2, true, 'add-project'],
    ['one project, no hire', 1, 0, false, 'staff'],
    ['one project, no hire, work reported', 1, 0, true, 'staff'],
    ['one project, one hire with no work', 1, 1, false, 'get-working'],
    ['one project, one hire with work', 1, 1, true, null]
  ] as const)('returns %s: %s', (_case, projects, hires, teamHasWork, stage) => {
    expect(onboardingStage(projects, hires, teamHasWork)).toBe(stage)
  })
})

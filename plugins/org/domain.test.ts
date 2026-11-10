import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  descendantsOf,
  HiredAgent,
  HireId,
  JOB_TITLE_NAME_MAX_LENGTH,
  JobTitleId,
  JobTitleName,
  jobSummary,
  OverallCap,
  TeamPlan
} from './domain'

const isJobTitleName = Schema.is(JobTitleName)
const isOverallCap = Schema.is(OverallCap)

describe('JobTitleName', () => {
  it.each([
    ['a one-character name', 'a', true],
    ['a name at the maximum length', 'r'.repeat(JOB_TITLE_NAME_MAX_LENGTH), true],
    ['an empty name', '', false],
    ['a name one past the maximum length', 'r'.repeat(JOB_TITLE_NAME_MAX_LENGTH + 1), false],
    ['a name with a leading space', ' reviewer', false],
    ['a name with a trailing space', 'reviewer ', false]
  ])('accepts %s: %s', (_case, input, accepted) => {
    expect(isJobTitleName(input)).toBe(accepted)
  })
})

describe('OverallCap', () => {
  it.each([
    [1, true],
    [4, true],
    [0, false],
    [-1, false],
    [1.5, false]
  ])('accepts %d: %s', (input, accepted) => {
    expect(isOverallCap(input)).toBe(accepted)
  })
})

const hireId = (n: number) => HireId.make(`00000000-0000-4000-8000-00000000000${n}`)
const agent = (n: number, reportsTo: number | null) =>
  HiredAgent.make({
    id: hireId(n),
    jobTitleId: JobTitleId.make('00000000-0000-4000-8000-000000000100'),
    name: null,
    bypassOverride: null,
    reportsTo: reportsTo === null ? null : hireId(reportsTo),
    hiredAt: n
  })

describe('descendantsOf', () => {
  const org = [agent(1, null), agent(2, 1), agent(3, 2), agent(4, null), agent(5, 4)]

  it.each([
    ['every agent below a root, through any chain', 1, [2, 3]],
    ['the agents below a mid-chain agent', 2, [3]],
    ['nothing for a leaf', 3, []],
    ['only its own branch for a second root', 4, [5]]
  ])('returns %s', (_case, root, below) => {
    expect([...descendantsOf(org, hireId(root))].sort()).toEqual(below.map(hireId))
  })
})

describe('jobSummary', () => {
  it.each([
    ['the first line of several', 'Builds features.\nWrites tests.', 'Builds features.'],
    ['the first non-empty line, trimmed', '\n  \n  Reviews code.  \nMore.', 'Reviews code.'],
    ['empty for a blank description', ' \n ', '']
  ])('returns %s', (_case, jobDescription, summary) => {
    expect(jobSummary({ jobDescription })).toBe(summary)
  })
})

describe('TeamPlan', () => {
  const ENGINEER = JobTitleId.make('00000000-0000-4000-8000-100000000002')
  const isTeamPlan = Schema.is(TeamPlan)

  it.each([
    ['a lead alone', { lead: ENGINEER, members: [] }, true],
    ['members alone', { lead: null, members: [ENGINEER] }, true],
    ['no lead and no member', { lead: null, members: [] }, false]
  ])('accepts %s: %s', (_case, plan, accepted) => {
    expect(isTeamPlan(plan)).toBe(accepted)
  })
})

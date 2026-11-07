import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { OverallCap, ROLE_NAME_MAX_LENGTH, RoleName } from './domain'

const isRoleName = Schema.is(RoleName)
const isOverallCap = Schema.is(OverallCap)

describe('RoleName', () => {
  it.each([
    ['a one-character name', 'a', true],
    ['a name at the maximum length', 'r'.repeat(ROLE_NAME_MAX_LENGTH), true],
    ['an empty name', '', false],
    ['a name one past the maximum length', 'r'.repeat(ROLE_NAME_MAX_LENGTH + 1), false],
    ['a name with a leading space', ' reviewer', false],
    ['a name with a trailing space', 'reviewer ', false]
  ])('accepts %s: %s', (_case, input, accepted) => {
    expect(isRoleName(input)).toBe(accepted)
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

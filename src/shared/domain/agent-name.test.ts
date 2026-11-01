import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { agentNameFromBranch, agentNameFromTitle } from './agent-name'

describe('agentNameFromBranch', () => {
  it('takes the name after the dia/ prefix', () => {
    expect(agentNameFromBranch('dia/brave-otter')).toEqual(Option.some('brave-otter'))
  })

  it('is none for a branch without the dia/ prefix', () => {
    expect(agentNameFromBranch('feature/brave-otter')).toEqual(Option.none())
  })

  it('is none for a branch that only mentions dia/ later', () => {
    expect(agentNameFromBranch('fix/dia/brave-otter')).toEqual(Option.none())
  })

  it('is none when nothing follows the prefix', () => {
    expect(agentNameFromBranch('dia/')).toEqual(Option.none())
  })

  it('is none when there is no branch', () => {
    expect(agentNameFromBranch(undefined)).toEqual(Option.none())
  })
})

describe('agentNameFromTitle', () => {
  it('uses a title as the name without its surrounding spaces', () => {
    expect(agentNameFromTitle('  Fix the login bug ')).toEqual(Option.some('Fix the login bug'))
  })

  it('cuts a title longer than 64 characters to its first 64', () => {
    const title = `${'a'.repeat(64)}bcd`

    expect(agentNameFromTitle(title)).toEqual(Option.some('a'.repeat(64)))
  })

  it('drops the space a cut leaves at the end', () => {
    const title = `${'a'.repeat(63)} tail`

    expect(agentNameFromTitle(title)).toEqual(Option.some('a'.repeat(63)))
  })

  it('gives no name for a blank title', () => {
    expect(agentNameFromTitle('   ')).toEqual(Option.none())
  })
})

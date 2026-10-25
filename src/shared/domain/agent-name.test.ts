import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { agentNameFromBranch } from './agent-name'

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

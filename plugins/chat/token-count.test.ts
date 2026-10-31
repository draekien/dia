import { describe, expect, it } from 'vitest'
import { approximateTokens, exactTokens } from './token-count'

describe('approximateTokens', () => {
  it('rounds to the nearest thousand with a tilde', () => {
    expect(approximateTokens(94533)).toBe('~95k')
  })

  it('rounds down below the half thousand', () => {
    expect(approximateTokens(23465)).toBe('~23k')
  })

  it('shows a count from 500 as ~1k', () => {
    expect(approximateTokens(500)).toBe('~1k')
  })

  it('shows a count below 500 as <1k', () => {
    expect(approximateTokens(499)).toBe('<1k')
  })

  it('shows zero as <1k', () => {
    expect(approximateTokens(0)).toBe('<1k')
  })
})

describe('exactTokens', () => {
  it('groups thousands with commas and names the unit', () => {
    expect(exactTokens(94533)).toBe('94,533 tokens')
  })

  it('leaves a count below a thousand ungrouped', () => {
    expect(exactTokens(420)).toBe('420 tokens')
  })
})

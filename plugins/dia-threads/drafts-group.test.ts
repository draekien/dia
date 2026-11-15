import { describe, expect, it } from 'vitest'
import { draftTitle } from './drafts-group'

describe('draftTitle', () => {
  it('is the first line that has text', () => {
    expect(draftTitle('\n  Fix the login  \nthen deploy')).toBe('Fix the login')
  })

  it('is "Empty" for a draft with no text', () => {
    expect(draftTitle('  \n ')).toBe('Empty')
  })
})

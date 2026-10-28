import { describe, expect, it } from 'vitest'
import { isExternalUrl } from './external-url'

describe('isExternalUrl', () => {
  it.each(['https://example.com/docs', 'http://localhost:3000', 'mailto:someone@example.com'])(
    'allows the web or mail URL %s',
    (url) => {
      expect(isExternalUrl(url)).toBe(true)
    }
  )

  it.each([
    'file://attacker/share',
    'file:///C:/Windows/System32/calc.exe',
    'dia://attacker/share',
    'ms-settings:',
    'javascript:alert(1)',
    'tel:+61200000000'
  ])('refuses the non-web URL %s', (url) => {
    expect(isExternalUrl(url)).toBe(false)
  })

  it.each(['', 'not a url', '//attacker/share'])('refuses the unparseable URL %j', (url) => {
    expect(isExternalUrl(url)).toBe(false)
  })
})

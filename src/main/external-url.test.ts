import { describe, expect, it } from 'vitest'
import { isAppNavigation, isExternalUrl } from './external-url'

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

describe('isAppNavigation', () => {
  const appOrigins = ['dia://app', 'http://localhost:5173']

  it.each([
    'dia://app/index.html',
    'dia://app/index.html?nav=1#tab',
    'http://localhost:5173/settings'
  ])('keeps the in-app URL %s in the window', (url) => {
    expect(isAppNavigation(url, appOrigins)).toBe(true)
  })

  it.each([
    'dia://attacker/share',
    'http://localhost:5174/',
    'https://localhost:5173/',
    'https://example.com/',
    'not a url'
  ])('treats %s as leaving the app', (url) => {
    expect(isAppNavigation(url, appOrigins)).toBe(false)
  })
})

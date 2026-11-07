import { describe, expect, it } from 'vitest'
import { resolvePluginExport } from './plugin-export'

const manifests: Record<string, ReadonlyArray<string>> = {
  org: ['domain.ts', 'calls/hire.ts'],
  example: []
}

const resolve = (specifier: string) => resolvePluginExport(specifier, (plugin) => manifests[plugin])

describe('resolvePluginExport', () => {
  it('names the plugin and the listed file for a top-level export', () => {
    expect(resolve('@dia-plugin/org/domain')).toEqual({ plugin: 'org', file: 'domain.ts' })
  })

  it('names the listed file for an export in a subdirectory', () => {
    expect(resolve('@dia-plugin/org/calls/hire')).toEqual({ plugin: 'org', file: 'calls/hire.ts' })
  })

  it('ignores a specifier outside @dia-plugin/', () => {
    expect(resolve('@dia/plugin')).toBeUndefined()
  })

  it('refuses a plugin that does not exist, naming the specifier and the plugin', () => {
    expect(resolve('@dia-plugin/billing/domain')).toEqual({
      message: 'Cannot import "@dia-plugin/billing/domain": no plugin named "billing"'
    })
  })

  it('refuses a file the plugin does not list', () => {
    expect(resolve('@dia-plugin/org/org')).toEqual({
      message: 'Cannot import "@dia-plugin/org/org": plugin "org" does not export "org.ts"'
    })
  })

  it('refuses any file of a plugin that exports nothing', () => {
    expect(resolve('@dia-plugin/example/messages')).toEqual({
      message:
        'Cannot import "@dia-plugin/example/messages": plugin "example" does not export "messages.ts"'
    })
  })

  it.each(['@dia-plugin/org', '@dia-plugin/org/', '@dia-plugin//domain'])(
    'refuses %s, which does not name both a plugin and a file',
    (specifier) => {
      expect(resolve(specifier)).toEqual({
        message: `Cannot import "${specifier}": name a plugin and a file, as @dia-plugin/<plugin>/<file>`
      })
    }
  )
})

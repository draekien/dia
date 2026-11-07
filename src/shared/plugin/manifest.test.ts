import { assert, describe, it } from '@effect/vitest'
import { Result, Schema } from 'effect'
import { isApiCompatible, PluginManifest } from './manifest'

const decode = Schema.decodeUnknownResult(PluginManifest, { errors: 'all' })

const failureOf = (input: unknown): string => {
  const result = decode(input)
  if (Result.isSuccess(result)) throw new Error('expected the manifest to fail to decode')
  return String(result.failure)
}

describe('PluginManifest', () => {
  it('decodes a feature that declares every optional field', () => {
    const feature = {
      name: 'chat',
      api: '1.0.0',
      category: 'feature',
      host: 'host.ts',
      renderer: 'renderer.ts',
      inject: ['db'],
      load: 'eager'
    } as const

    assert.deepStrictEqual(Result.getOrThrow(decode(feature)), feature)
  })

  it('decodes an adapter with a host entry', () => {
    const adapter = {
      name: 'claude-code',
      api: '1.0.0',
      category: 'adapter',
      host: 'host.ts'
    } as const

    assert.deepStrictEqual(Result.getOrThrow(decode(adapter)), adapter)
  })

  it('decodes an adapter with a renderer entry, inject and a load mode', () => {
    const adapter = {
      name: 'claude-code',
      api: '1.0.0',
      category: 'adapter',
      host: 'host.ts',
      renderer: 'renderer.ts',
      inject: ['db'],
      load: 'lazy'
    } as const

    assert.deepStrictEqual(Result.getOrThrow(decode(adapter)), adapter)
  })

  const categoryCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['has no category', { name: 'chat', api: '1.0.0', host: 'host.ts' }],
    [
      'has an unknown category',
      { name: 'chat', api: '1.0.0', category: 'service', host: 'host.ts' }
    ]
  ]

  for (const [name, input] of categoryCases) {
    it(`asks for a category when the manifest ${name}`, () => {
      assert.include(
        failureOf(input),
        'plugin.json must declare "category" as "feature" or "adapter"'
      )
    })
  }
})

describe('PluginManifest api', () => {
  it('refuses a version that is not MAJOR.MINOR.PATCH', () => {
    assert.include(
      failureOf({ name: 'chat', api: '1', category: 'feature' }),
      'expected a plugin API version such as "1.0.0"'
    )
  })
})

describe('isApiCompatible', () => {
  const cases: ReadonlyArray<readonly [string, string, boolean, string]> = [
    ['1.1.0', '1.0.0', true, 'an older minor version on the same major'],
    ['1.1.0', '1.1.0', true, 'the same version'],
    ['1.1.0', '1.1.9', true, 'a different patch version'],
    ['1.1.0', '1.1.12', true, 'a patch version of two digits'],
    ['1.1.0', '1x1x0', false, 'parts separated by something other than dots'],
    ['1.1.0', '1.2.0', false, 'a newer minor version'],
    ['1.1.0', '2.0.0', false, 'a newer major version'],
    ['1.1.0', '0.1.0', false, 'an older major version'],
    ['1.1.0', '1', false, 'a version that is not MAJOR.MINOR.PATCH'],
    ['0.0.1', '0.0.1', true, 'the same 0.0 version'],
    ['0.0.2', '0.0.1', false, 'an older patch version below 0.1.0'],
    ['0.0.1', '0.0.2', false, 'a newer patch version below 0.1.0'],
    ['0.2.0', '0.2.5', true, 'a different patch version on the same 0 minor'],
    ['0.2.0', '0.1.0', false, 'an older minor version below 1.0.0'],
    ['0.1.0', '0.2.0', false, 'a newer minor version below 1.0.0']
  ]

  for (const [host, plugin, expected, condition] of cases) {
    it(`is ${expected} for ${condition} (${plugin} on ${host})`, () => {
      assert.strictEqual(isApiCompatible(host, plugin), expected)
    })
  }
})

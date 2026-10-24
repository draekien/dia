import { assert, describe, it } from '@effect/vitest'
import { Result, Schema } from 'effect'
import { PluginManifest } from './manifest'

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
      api: '1',
      category: 'feature',
      host: 'host.ts',
      renderer: 'renderer.ts',
      inject: ['db'],
      load: 'eager'
    } as const

    assert.deepStrictEqual(Result.getOrThrow(decode(feature)), feature)
  })

  it('decodes an adapter with a host entry', () => {
    const adapter = { name: 'claude-code', api: '1', category: 'adapter', host: 'host.ts' } as const

    assert.deepStrictEqual(Result.getOrThrow(decode(adapter)), adapter)
  })

  it('reports every adapter problem in one failure', () => {
    const message = failureOf({
      name: 'claude-code',
      api: '1',
      category: 'adapter',
      renderer: 'renderer.ts',
      inject: ['db'],
      load: 'lazy'
    })

    for (const problem of [
      'an adapter needs a "host" entry, because it runs in the Host',
      'an adapter has no UI, so it cannot declare "renderer"',
      'an adapter cannot declare "inject": a reload of the plugin it injects from would close the adapter',
      'an adapter always loads at startup, so it cannot declare "load"'
    ]) {
      assert.include(message, problem)
    }
  })

  const categoryCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['has no category', { name: 'chat', api: '1', host: 'host.ts' }],
    ['has an unknown category', { name: 'chat', api: '1', category: 'service', host: 'host.ts' }]
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

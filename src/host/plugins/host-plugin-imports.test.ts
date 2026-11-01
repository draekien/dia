// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test reads the shipped plugin sources from disk.
import { readdirSync, readFileSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test builds paths into the plugins directory.
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'

const PLUGINS = 'plugins'
const RUNTIME_SHARED_IMPORT = /import\s+(?!type\b)[^']*from\s+'@shared\//

const hostPlugins = readdirSync(PLUGINS).filter((name) => {
  const manifest = JSON.parse(readFileSync(join(PLUGINS, name, 'plugin.json'), 'utf8'))
  return typeof manifest.host === 'string'
})

describe('host plugin sources', () => {
  for (const plugin of hostPlugins) {
    it(`${plugin} imports no runtime value from @shared, which the packaged loader cannot resolve`, () => {
      const offenders = readdirSync(join(PLUGINS, plugin))
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .filter((file) =>
          RUNTIME_SHARED_IMPORT.test(readFileSync(join(PLUGINS, plugin, file), 'utf8'))
        )

      assert.deepStrictEqual(offenders, [])
    })
  }
})

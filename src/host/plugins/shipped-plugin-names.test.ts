// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test reads the shipped plugin manifests from disk.
import { readdirSync, readFileSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test builds paths into plugins/.
import { join, resolve } from 'node:path'
import { assert, describe, it } from '@effect/vitest'

const PLUGINS = resolve(__dirname, '../../../plugins')

const folders = readdirSync(PLUGINS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

const manifestName = (folder: string): unknown =>
  JSON.parse(readFileSync(join(PLUGINS, folder, 'plugin.json'), 'utf8')).name

describe('shipped plugin names (ADR-0077)', () => {
  it('names every plugin folder dia-<name>', () => {
    assert.deepStrictEqual(
      folders.filter((folder) => !folder.startsWith('dia-')),
      []
    )
  })

  it('gives every plugin.json the name of its folder', () => {
    assert.deepStrictEqual(
      folders.filter((folder) => manifestName(folder) !== folder),
      []
    )
  })
})

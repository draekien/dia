// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test reads the sources under src/ and plugins/ from disk.
import { readdirSync, readFileSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test builds paths into src/ and plugins/.
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = resolve(__dirname, '../../../..')
const REMOVED_API = /\baddPage\b|\baddRailCard\b|\busePages\b/

const sourcesUnder = (directory: string): ReadonlyArray<string> =>
  readdirSync(join(REPO, directory), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !file.includes('node_modules'))
    .map((file) => join(REPO, directory, file))

describe('the list slot migration', () => {
  it('leaves no use of addPage, addRailCard or usePages in src/ or plugins/', () => {
    const offenders = [...sourcesUnder('src'), ...sourcesUnder('plugins')]
      .filter((path) => path !== __filename)
      .filter((path) => REMOVED_API.test(readFileSync(path, 'utf8')))

    expect(offenders).toEqual([])
  })
})

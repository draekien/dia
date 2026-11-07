// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test reads the sources under src/.
import * as fs from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test resolves paths under src/.
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '../..')
const THIS_FILE = relative(SRC, __filename)
const ORG_MENTIONS = /\bORG_KEY\b|\b(?:interface|type) Org\b/

const sourceFiles = (): ReadonlyArray<string> =>
  fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && file !== THIS_FILE)

describe('org ownership', () => {
  it('leaves the Org type and its key to the org plugin', () => {
    const mentions = sourceFiles().filter((file) =>
      ORG_MENTIONS.test(fs.readFileSync(join(SRC, file), 'utf8'))
    )

    expect(mentions).toEqual([])
  })
})

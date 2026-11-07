// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test reads the sources under src/ from disk.
import { readdirSync, readFileSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test builds paths into src/.
import { join, relative, resolve } from 'node:path'
import { assert, describe, it } from '@effect/vitest'

const SRC = resolve(__dirname, '../..')
const THIS_FILE = relative(SRC, __filename)
const ORG_MENTION = /\bORG_KEY\b|\b(?:interface|type) Org\b/

describe('org ownership', () => {
  it('leaves the Org type and its key to the org plugin', () => {
    const offenders = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file) && file !== THIS_FILE)
      .filter((file) => ORG_MENTION.test(readFileSync(join(SRC, file), 'utf8')))

    assert.deepStrictEqual(offenders, [])
  })
})

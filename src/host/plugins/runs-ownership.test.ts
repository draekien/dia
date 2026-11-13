// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test reads the sources under src/ from disk.
import { readdirSync, readFileSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test builds paths into src/.
import { join, relative, resolve } from 'node:path'
import { assert, describe, it } from '@effect/vitest'

const SRC = resolve(__dirname, '../..')
const THIS_FILE = relative(SRC, __filename)
const BACKEND_IMPORT = /import[^;]*\bAgentBackend(?:Key)?\b[^;]*from|dia-runs\/backend/

describe('runs ownership', () => {
  it('leaves the agent backend to the dia-runs plugin: no kernel file imports it', () => {
    const offenders = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file) && file !== THIS_FILE)
      .filter((file) => BACKEND_IMPORT.test(readFileSync(join(SRC, file), 'utf8')))

    assert.deepStrictEqual(offenders, [])
  })
})

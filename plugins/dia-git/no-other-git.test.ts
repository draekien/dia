// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test reads source files from disk.
import { readdirSync, readFileSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test builds paths into the repository.
import { join, relative, resolve } from 'node:path'
import { assert, describe, it } from '@effect/vitest'

const ROOT = resolve(__dirname, '../..')

const GIT_SPAWN = /ChildProcess\.make\(\s*['"`]git['"`]/

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

describe('git processes', () => {
  it('are started only by dia-git', () => {
    const spawners = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'plugins'))]
      .filter((file) => GIT_SPAWN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file).replaceAll('\\', '/'))

    assert.deepStrictEqual(spawners, ['plugins/dia-git/git.ts'])
  })
})

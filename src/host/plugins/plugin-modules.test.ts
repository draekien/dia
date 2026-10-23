// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test runs the module loader in a child Node process because vitest's module runner bypasses Node's resolve hooks.
import { spawnSync } from 'node:child_process'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test creates a scratch plugin directory for the child process.
import { mkdtempSync, rmSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test builds paths for the scratch plugin directory.
import { join } from 'node:path'
import { afterAll, assert, beforeAll, describe, it } from '@effect/vitest'

interface Reload {
  readonly evaluated: ReadonlyArray<string>
  readonly failure: {
    readonly tag: string | null
    readonly reason: string | null
    readonly message: string
  } | null
}

let results: Record<string, Reload>
let scratch: string

beforeAll(() => {
  scratch = mkdtempSync(join(process.cwd(), 'plugin-modules-'))
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      join('src', 'host', 'plugins', 'fixtures', 'plugin-modules-driver.mjs'),
      scratch
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.base.json' },
      encoding: 'utf8'
    }
  )
  const line = run.stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '))
  if (line === undefined) throw new Error(`driver printed no result: ${run.stderr}`)
  results = JSON.parse(line.slice('RESULT '.length))
}, 60_000)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('processPluginModules', () => {
  it('evaluates every module of a plugin on its first load', () => {
    assert.deepStrictEqual(results.firstLoad?.evaluated, ['dep', 'entry', 'sibling'])
  })

  it('evaluates no module when nothing changed since the last load', () => {
    assert.deepStrictEqual(results.unchangedReload?.evaluated, [])
  })

  it('evaluates a changed module and its importer but not an unrelated module', () => {
    assert.deepStrictEqual(results.depEdited?.evaluated, ['dep', 'entry'])
  })

  it('fails the load when a changed module throws while evaluating', () => {
    assert.include(results.brokenDep?.failure?.message ?? '', 'broken dep')
  })

  it('evaluates the broken module again on the next load after a failed one', () => {
    assert.include(results.brokenDepAgain?.failure?.message ?? '', 'broken dep')
    assert.include(results.brokenDepAgain?.evaluated, 'dep')
  })

  it('loads the fixed module and its importer once the module is repaired', () => {
    assert.strictEqual(results.depFixed?.failure, null)
    assert.deepStrictEqual(results.depFixed?.evaluated, ['dep', 'entry'])
  })

  it('evaluates nothing on the load after a repaired one', () => {
    assert.deepStrictEqual(results.afterFix?.evaluated, [])
  })

  it('evaluates a module first imported by a failed load again once it is edited', () => {
    assert.include(results.lateBrokenEntry?.failure?.message ?? '', 'broken entry')
    assert.strictEqual(results.lateRepaired?.failure, null)
    assert.deepStrictEqual(results.lateRepaired?.evaluated, ['entry', 'helper'])
  })

  it('loads a plugin that imports a file outside its directory the first time', () => {
    assert.deepStrictEqual(results.outsideFirstLoad?.evaluated, ['entry', 'shared'])
  })

  it('requires a restart when a file outside the plugin directory changed', () => {
    assert.strictEqual(results.outsideEdited?.failure?.tag, 'PluginRestartRequiredError')
    assert.strictEqual(results.outsideEdited?.failure?.reason, 'dependency')
    assert.include(results.outsideEdited?.failure?.message ?? '', 'shared.mjs')
    assert.deepStrictEqual(results.outsideEdited?.evaluated, [])
  })
})

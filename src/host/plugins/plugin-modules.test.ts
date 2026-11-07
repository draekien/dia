// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test runs the module loader in a child Node process because vitest's module runner bypasses Node's resolve hooks.
import { spawnSync } from 'node:child_process'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test creates a scratch plugin directory for the child process.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test builds paths for the scratch plugin directory.
import { join } from 'node:path'
import { afterAll, assert, beforeAll, describe, it } from '@effect/vitest'

interface Reload {
  readonly evaluated: ReadonlyArray<string>
  readonly importers: ReadonlyArray<string> | null
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

  it('resolves @dia/plugin inside a plugin to the module the Host was given', () => {
    assert.strictEqual(results.pluginApi?.failure, null)
    assert.deepStrictEqual(results.pluginApi?.evaluated, ['entry', 'saw:api'])
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

describe("imports of another plugin's exports", () => {
  it('resolves an export of a plugin that has not loaded yet', () => {
    assert.deepStrictEqual(results.importerBeforeExporter?.evaluated, ['messages:v1', 'saw:v1'])
  })

  it('shares one module instance between an importer and the exporter that loads after it', () => {
    assert.deepStrictEqual(results.exporterAfterImporter?.evaluated, ['entry'])
  })

  it('reports no importer when the exporter loads without changes', () => {
    assert.deepStrictEqual(results.exporterAfterImporter?.importers, [])
  })

  it('reports the importer when the exporter loads an edited export', () => {
    assert.deepStrictEqual(results.exporterEdited?.importers, ['importer'])
  })

  it('gives the importer the edited export when it loads again', () => {
    assert.deepStrictEqual(results.importerAfterEdit?.evaluated, ['saw:v2'])
  })

  it('keeps the copy the exporter last loaded until the exporter loads from its override', () => {
    assert.deepStrictEqual(results.importerBeforeOverrideLoads?.evaluated, [])
  })

  it('reports the importer when the exporter loads from an override directory', () => {
    assert.deepStrictEqual(results.exporterOverridden?.importers, ['importer'])
  })

  it("gives the importer the override directory's export when it loads again", () => {
    assert.deepStrictEqual(results.importerAfterOverride?.evaluated, ['saw:override'])
  })

  it('gives the importer the new directory of an exporter that never loaded', () => {
    assert.deepStrictEqual(results.unloadedOverridden?.evaluated, [
      'messages:unloaded-override',
      'saw:unloaded-override'
    ])
  })

  it('gives the importer the edited export of an exporter that never loaded', () => {
    assert.deepStrictEqual(results.unloadedEdited?.evaluated, [
      'messages:unloaded-edited',
      'saw:unloaded-edited'
    ])
  })

  it('fails the importer with the specifier when no plugin has that name', () => {
    assert.include(
      results.unknownPlugin?.failure?.message ?? '',
      'Cannot import "@dia-plugin/missing/messages": no plugin named "missing"'
    )
  })

  it('fails the importer when the exporter does not list the file', () => {
    assert.include(
      results.unlistedFile?.failure?.message ?? '',
      'plugin "exporter" does not export "entry.ts"'
    )
  })
})

describe('type-only imports under the type stripping the Host loads plugins with', () => {
  const MISSING = 'dia-package-that-does-not-exist'

  const loadWithTypeStripping = (imports: string) => {
    const file = join(scratch, `type-only-${imports.length}.ts`)
    writeFileSync(file, `${imports}\nexport type Card = Missing\nconsole.log('loaded')\n`)
    return spawnSync(process.execPath, [file], { encoding: 'utf8' })
  }

  it('erases a whole import type statement, so the package it names is never loaded', () => {
    const run = loadWithTypeStripping(`import type {\n  Missing\n} from '${MISSING}'`)

    assert.strictEqual(run.stdout.trim(), 'loaded')
  })

  it('keeps an inline type import, so the package it names is loaded', () => {
    const run = loadWithTypeStripping(`import { type Missing } from '${MISSING}'`)

    assert.include(run.stderr, MISSING)
  })
})

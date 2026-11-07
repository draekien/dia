import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Cause, Effect } from 'effect'
import { makePluginModules } from '../plugin-modules.ts'

const [base] = process.argv.slice(2)
const pluginApiFile = join(base, 'plugin-api.mjs')
const processPluginModules = makePluginModules(pathToFileURL(pluginApiFile).href)
globalThis.__evals = []

const moduleSource = (name, extra = '') =>
  `globalThis.__evals.push('${name}')\n${extra}\nexport const ${name} = 1\n`

const write = (directory, file, source) => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, file), source)
}

const reload = async (root, name = root, exports = []) => {
  globalThis.__evals.length = 0
  let importers = null
  const exit = await Effect.runPromiseExit(
    processPluginModules.transact(name, root, exports, (reported) => {
      importers = reported
      return Effect.tryPromise(() =>
        processPluginModules.importEntry(root, join(root, 'entry.mjs'))
      )
    })
  )
  const failure = exit._tag === 'Failure' ? Cause.squash(exit.cause) : undefined
  return {
    evaluated: [...globalThis.__evals].sort(),
    importers,
    failure:
      failure === undefined
        ? null
        : {
            tag: failure._tag ?? null,
            reason: failure.reason ?? null,
            message: String(failure.cause?.message ?? failure.message)
          }
  }
}

const results = {}

const root = join(base, 'plugin')
const entrySource = moduleSource('entry', "import './dep.mjs'\nimport './sibling.mjs'")
write(root, 'dep.mjs', moduleSource('dep'))
write(root, 'sibling.mjs', moduleSource('sibling'))
write(root, 'entry.mjs', entrySource)
results.firstLoad = await reload(root)
results.unchangedReload = await reload(root)

write(root, 'dep.mjs', moduleSource('dep', '// edited'))
results.depEdited = await reload(root)

write(root, 'dep.mjs', moduleSource('dep', "throw new Error('broken dep')"))
results.brokenDep = await reload(root)
results.brokenDepAgain = await reload(root)

write(root, 'dep.mjs', moduleSource('dep', '// fixed again'))
results.depFixed = await reload(root)
results.afterFix = await reload(root)

const lateRoot = join(base, 'plugin-late')
write(lateRoot, 'entry.mjs', moduleSource('entry'))
results.lateFirstLoad = await reload(lateRoot)
write(lateRoot, 'helper.mjs', moduleSource('helper'))
write(
  lateRoot,
  'entry.mjs',
  moduleSource('entry', "import './helper.mjs'\nthrow new Error('broken entry')")
)
results.lateBrokenEntry = await reload(lateRoot)
write(lateRoot, 'helper.mjs', moduleSource('helper', '// edited after the failed load'))
write(lateRoot, 'entry.mjs', moduleSource('entry', "import './helper.mjs'"))
results.lateRepaired = await reload(lateRoot)

const outsideRoot = join(base, 'plugin-outside')
write(base, 'shared.mjs', moduleSource('shared'))
write(outsideRoot, 'entry.mjs', moduleSource('entry', "import '../shared.mjs'"))
results.outsideFirstLoad = await reload(outsideRoot)
write(base, 'shared.mjs', moduleSource('shared', '// edited outside the plugin'))
results.outsideEdited = await reload(outsideRoot)

write(base, 'plugin-api.mjs', "export const marker = 'api'\n")
const apiRoot = join(base, 'plugin-api')
write(
  apiRoot,
  'entry.mjs',
  moduleSource(
    'entry',
    "import { marker } from '@dia/plugin'\nglobalThis.__evals.push('saw:' + marker)"
  )
)
results.pluginApi = await reload(apiRoot)

const messagesSource = (version) =>
  `globalThis.__evals.push('messages:${version}')\nexport const version = '${version}'\n`
const importerSource = (specifier) =>
  `import { version } from '${specifier}'\nglobalThis.__evals.push('saw:' + version)\n`

const exporterRoot = join(base, 'exporter')
write(exporterRoot, 'messages.ts', messagesSource('v1'))
write(exporterRoot, 'entry.mjs', moduleSource('entry', "import './messages.ts'"))
const importerRoot = join(base, 'importer')
write(importerRoot, 'entry.mjs', importerSource('@dia-plugin/exporter/messages'))

processPluginModules.declare('exporter', exporterRoot, ['messages.ts'])
results.importerBeforeExporter = await reload(importerRoot, 'importer')
results.exporterAfterImporter = await reload(exporterRoot, 'exporter', ['messages.ts'])

write(exporterRoot, 'messages.ts', messagesSource('v2'))
results.exporterEdited = await reload(exporterRoot, 'exporter', ['messages.ts'])
results.importerAfterEdit = await reload(importerRoot, 'importer')

const overrideRoot = join(base, 'exporter-override')
write(overrideRoot, 'messages.ts', messagesSource('override'))
write(overrideRoot, 'entry.mjs', moduleSource('entry', "import './messages.ts'"))
processPluginModules.declare('exporter', overrideRoot, ['messages.ts'])
results.importerBeforeOverrideLoads = await reload(importerRoot, 'importer')
results.exporterOverridden = await reload(overrideRoot, 'exporter', ['messages.ts'])
results.importerAfterOverride = await reload(importerRoot, 'importer')

const unloadedRoot = join(base, 'unloaded')
write(unloadedRoot, 'messages.ts', messagesSource('unloaded'))
const unloadedOverrideRoot = join(base, 'unloaded-override')
write(unloadedOverrideRoot, 'messages.ts', messagesSource('unloaded-override'))
const secondImporterRoot = join(base, 'second-importer')
write(secondImporterRoot, 'entry.mjs', importerSource('@dia-plugin/unloaded/messages'))
processPluginModules.declare('unloaded', unloadedRoot, ['messages.ts'])
results.unloadedFirst = await reload(secondImporterRoot, 'second-importer')
processPluginModules.declare('unloaded', unloadedOverrideRoot, ['messages.ts'])
results.unloadedOverridden = await reload(secondImporterRoot, 'second-importer')
write(unloadedOverrideRoot, 'messages.ts', messagesSource('unloaded-edited'))
results.unloadedEdited = await reload(secondImporterRoot, 'second-importer')

const unknownRoot = join(base, 'unknown-importer')
write(unknownRoot, 'entry.mjs', importerSource('@dia-plugin/missing/messages'))
results.unknownPlugin = await reload(unknownRoot, 'unknown-importer')

const unlistedRoot = join(base, 'unlisted-importer')
write(unlistedRoot, 'entry.mjs', importerSource('@dia-plugin/exporter/entry'))
results.unlistedFile = await reload(unlistedRoot, 'unlisted-importer')

process.stdout.write(`RESULT ${JSON.stringify(results)}\n`)

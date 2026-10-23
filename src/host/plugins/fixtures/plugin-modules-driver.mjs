import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Cause, Effect } from 'effect'
import { processPluginModules } from '../plugin-modules.ts'

const [base] = process.argv.slice(2)
globalThis.__evals = []

const moduleSource = (name, extra = '') =>
  `globalThis.__evals.push('${name}')\n${extra}\nexport const ${name} = 1\n`

const write = (directory, file, source) => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, file), source)
}

const reload = async (root) => {
  globalThis.__evals.length = 0
  const exit = await Effect.runPromiseExit(
    processPluginModules.transact(
      root,
      Effect.tryPromise(() => processPluginModules.importEntry(root, join(root, 'entry.mjs')))
    )
  )
  const failure = exit._tag === 'Failure' ? Cause.squash(exit.cause) : undefined
  return {
    evaluated: [...globalThis.__evals].sort(),
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

process.stdout.write(`RESULT ${JSON.stringify(results)}\n`)

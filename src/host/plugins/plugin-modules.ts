// @effect-diagnostics-next-line nodeBuiltinImport:off -- the resolve hook Node calls is synchronous, so it cannot run an Effect FileSystem call.
import { statSync } from 'node:fs'
import { registerHooks } from 'node:module'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the resolve hook Node calls is synchronous, so it cannot use the Effect Path service.
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PluginCategory } from '@shared/plugin/manifest'
import { resolvePluginExport } from '@shared/plugin/plugin-export'
import { PluginRestartRequiredError } from '@shared/plugin/plugin-registry'
import { Effect, Exit } from 'effect'
import { ModuleGenerations } from './module-generations'

/**
 * How the Host imports plugin code.
 *
 * `declare` records that plugin `name` loads from `root`, has `category` and exports `exports`
 * (the files its `plugin.json` lists), so `import '@dia-plugin/<name>/<file>'` from a plugin
 * resolves there, whether or not `name` has loaded. It replaces the record until `transact` has
 * run for `name`; after that only `transact` changes it, so imports resolve to the copy that
 * was last loaded. Call it whenever a plugin's manifest is read.
 *
 * `importEntry` imports the module at the absolute path `entry`, which lies inside the plugin
 * directory `root`, and returns its namespace.
 *
 * `transact` runs `use`, which imports plugin code, as one load of plugin `name` from `root`:
 * modules whose source changed since the last load, the modules of `name`'s previous directory
 * when `root` differs from it, and every module that imports one of those evaluate again; the
 * rest keep their evaluated instance. `use` receives the other plugins that own a module that
 * evaluates again, ordered so each comes after the plugins it imports; load those again after
 * `transact` ends. When `use` fails, the module state and `name`'s record are restored to what
 * they were before `transact`. `transact` fails with {@link PluginRestartRequiredError} without
 * running `use` when a file outside every plugin directory that a plugin module imports directly
 * has changed, because such a file cannot be evaluated again in this process. Callers must not
 * run two `transact` calls at the same time.
 */
export interface PluginModules {
  readonly declare: (
    name: string,
    root: string,
    category: PluginCategory,
    exports: ReadonlyArray<string>
  ) => void
  readonly transact: <A, E, R>(
    name: string,
    root: string,
    category: PluginCategory,
    exports: ReadonlyArray<string>,
    use: (importers: ReadonlyArray<string>) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | PluginRestartRequiredError, R>
  readonly importEntry: (root: string, entry: string) => Promise<unknown>
}

interface Signature {
  readonly size: number
  readonly mtimeMs: number
}

interface PluginRecord {
  readonly root: string
  readonly prefix: string
  readonly category: PluginCategory
  readonly exports: ReadonlyArray<string>
  readonly transacted: boolean
}

const SHARED_LIBRARY = /^effect(\/|$)/

const PLUGIN_API = '@dia/plugin'

const withoutQuery = (url: string): string => {
  const query = url.indexOf('?')
  return query === -1 ? url : url.slice(0, query)
}

const rootPrefix = (root: string): string => pathToFileURL(root).href.replace(/\/?$/, '/')

const signatureOf = (url: string): Signature | undefined => {
  try {
    const { size, mtimeMs } = statSync(fileURLToPath(url))
    return { size, mtimeMs }
  } catch {
    return undefined
  }
}

const differs = (recorded: Signature, current: Signature | undefined): boolean =>
  current === undefined || current.size !== recorded.size || current.mtimeMs !== recorded.mtimeMs

/**
 * The names in `importers` in depth-first post-order over `importsOf`, visiting names in sorted
 * order, so each name comes after the names it imports. A cycle is broken at the first name
 * visited.
 */
const importOrder = (
  importers: ReadonlySet<string>,
  importsOf: (name: string) => ReadonlySet<string>
): ReadonlyArray<string> => {
  const ordered: Array<string> = []
  const visited = new Set<string>()
  const visit = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    for (const imported of [...importsOf(name)].sort()) {
      if (importers.has(imported)) visit(imported)
    }
    ordered.push(name)
  }
  for (const name of [...importers].sort()) visit(name)
  return ordered
}

/**
 * Builds a {@link PluginModules}. Each instance installs a process-wide resolution hook on first
 * use, so create one per process. When `pluginApiUrl` is a file URL, an `import '@dia/plugin'`
 * made from inside a plugin resolves to that module, which gives plugin code the Host's runtime
 * values (the protocol schemas); without it the specifier resolves as Node would resolve it.
 */
export const makePluginModules = (pluginApiUrl: string | undefined): PluginModules => {
  const generations = new ModuleGenerations()
  const roots = new Set<string>()
  let signatures = new Map<string, Signature>()
  let externals = new Map<string, Map<string, Signature>>()
  let records = new Map<string, PluginRecord>()
  let hooksInstalled = false

  const rootOf = (url: string | undefined): string | undefined => {
    if (url === undefined) return undefined
    for (const prefix of roots) if (url.startsWith(prefix)) return prefix
    return undefined
  }

  const pluginAt = (url: string): string | undefined => {
    for (const [name, record] of records) if (url.startsWith(record.prefix)) return name
    return undefined
  }

  const record = (known: Map<string, Signature>, url: string): void => {
    if (known.has(url)) return
    const signature = signatureOf(url)
    if (signature !== undefined) known.set(url, signature)
  }

  const exportTarget = (specifier: string, parentRoot: string): string => {
    const target = resolvePluginExport(specifier, (plugin) => records.get(plugin)?.exports)
    if (target === undefined) return specifier
    if ('message' in target) throw new Error(target.message)
    const importer = [...records].find(([, candidate]) => candidate.prefix === parentRoot)
    if (
      importer !== undefined &&
      importer[1].category === 'adapter' &&
      importer[0] !== target.plugin
    ) {
      throw new Error(
        `An adapter cannot import "${specifier}": reloading "${target.plugin}" would close the adapter`
      )
    }
    const exporter = records.get(target.plugin)
    if (exporter === undefined) return specifier
    return pathToFileURL(join(exporter.root, target.file)).href
  }

  const installHooks = (): void => {
    if (hooksInstalled) return
    hooksInstalled = true
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const parent = context.parentURL === undefined ? undefined : withoutQuery(context.parentURL)
        const parentRoot = rootOf(parent)
        if (specifier === PLUGIN_API && pluginApiUrl !== undefined && parentRoot !== undefined) {
          return { url: pluginApiUrl, format: 'module', shortCircuit: true }
        }
        const target = parentRoot === undefined ? specifier : exportTarget(specifier, parentRoot)
        const fromHost =
          SHARED_LIBRARY.test(specifier) && parentRoot !== undefined
            ? { ...context, parentURL: import.meta.url }
            : context
        const resolved = nextResolve(target, fromHost)
        const url = withoutQuery(resolved.url)
        if (rootOf(url) !== undefined) {
          if (parent !== undefined && parentRoot !== undefined) {
            generations.recordImport(parent, url)
          }
          record(signatures, url)
          return { ...resolved, url: generations.versioned(url) }
        }
        if (parentRoot !== undefined && url.startsWith('file:')) {
          let known = externals.get(parentRoot)
          if (known === undefined) {
            known = new Map()
            externals.set(parentRoot, known)
          }
          record(known, url)
        }
        return resolved
      }
    })
  }

  const snapshot = (): (() => void) => {
    const restoreGenerations = generations.snapshot()
    const savedSignatures = new Map(signatures)
    const savedExternals = new Map(
      [...externals].map(([prefix, known]) => [prefix, new Map(known)])
    )
    const savedRecords = new Map(records)
    return () => {
      restoreGenerations()
      for (const [url, signature] of signatures) {
        if (!savedSignatures.has(url)) savedSignatures.set(url, signature)
      }
      signatures = savedSignatures
      externals = savedExternals
      records = savedRecords
    }
  }

  const changedDependencies = (prefix: string): ReadonlyArray<string> =>
    [...(externals.get(prefix) ?? [])]
      .filter(([url, recorded]) => differs(recorded, signatureOf(url)))
      .map(([url]) => fileURLToPath(url))

  const changedModules = (prefix: string): ReadonlyMap<string, Signature | undefined> => {
    const changed = new Map<string, Signature | undefined>()
    for (const [url, recorded] of signatures) {
      if (!url.startsWith(prefix)) continue
      const current = signatureOf(url)
      if (differs(recorded, current)) changed.set(url, current)
    }
    return changed
  }

  const modulesUnder = (prefix: string): ReadonlyArray<string> =>
    [...signatures.keys()].filter((url) => url.startsWith(prefix))

  const pluginImports = (): ReadonlyMap<string, ReadonlySet<string>> => {
    const byPlugin = new Map<string, Set<string>>()
    for (const url of signatures.keys()) {
      const importer = pluginAt(url)
      if (importer === undefined) continue
      for (const imported of generations.importsOf(url)) {
        const exporter = pluginAt(imported)
        if (exporter === undefined || exporter === importer) continue
        const known = byPlugin.get(importer) ?? new Set<string>()
        known.add(exporter)
        byPlugin.set(importer, known)
      }
    }
    return byPlugin
  }

  const registerRoot = (root: string): string => {
    installHooks()
    const prefix = rootPrefix(root)
    roots.add(prefix)
    return prefix
  }

  const declare = (
    name: string,
    root: string,
    category: PluginCategory,
    exports: ReadonlyArray<string>
  ): void => {
    const prefix = registerRoot(root)
    const previous = records.get(name)
    if (previous?.transacted === true) return
    if (previous !== undefined && previous.prefix !== prefix) {
      generations.invalidate(modulesUnder(previous.prefix))
    }
    records.set(name, { root, prefix, category, exports, transacted: false })
  }

  const transact = <A, E, R>(
    name: string,
    root: string,
    category: PluginCategory,
    exports: ReadonlyArray<string>,
    use: (importers: ReadonlyArray<string>) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | PluginRestartRequiredError, R> =>
    Effect.gen(function* () {
      const prefix = registerRoot(root)

      const staleDependencies = changedDependencies(prefix)
      if (staleDependencies.length > 0) {
        yield* Effect.logWarning('Plugin dependency changed outside its directory', {
          root,
          files: staleDependencies
        })
        return yield* new PluginRestartRequiredError({
          reason: 'dependency',
          message: `Files outside the plugin directory changed: ${staleDependencies.join(', ')}. Restart dia to reload them.`
        })
      }

      const restore = snapshot()
      const changed = changedModules(prefix)
      const previous = records.get(name)
      const moved =
        previous !== undefined && previous.prefix !== prefix ? modulesUnder(previous.prefix) : []
      const imports = pluginImports()
      const affected = generations.invalidate([...changed.keys(), ...moved])
      for (const [url, current] of changed) {
        if (current === undefined) signatures.delete(url)
        else signatures.set(url, current)
      }
      const importerNames = new Set<string>()
      for (const url of affected) {
        const owner = pluginAt(url)
        if (owner !== undefined && owner !== name) importerNames.add(owner)
      }
      const importers = importOrder(importerNames, (plugin) => imports.get(plugin) ?? new Set())
      records.set(name, { root, prefix, category, exports, transacted: true })
      yield* Effect.logDebug('Plugin modules invalidated', {
        root,
        changed: [...changed.keys()],
        moved: moved.length,
        affected: affected.size,
        importers
      })

      const exit = yield* Effect.exit(use(importers))
      if (Exit.isFailure(exit)) {
        restore()
        yield* Effect.logDebug('Plugin module state restored after a failed reload', { root })
        return yield* Effect.failCause(exit.cause)
      }
      return exit.value
    })

  const importEntry = (root: string, entry: string): Promise<unknown> => {
    registerRoot(root)
    return import(pathToFileURL(entry).href)
  }

  return { declare, transact, importEntry }
}

/**
 * A {@link PluginModules} that does not resolve `@dia/plugin`, which a loader uses when it is
 * given none. The Host builds its own with {@link makePluginModules}. Imports of `effect` made
 * from inside a plugin resolve to the Host's own copy, so one copy of the library exists at
 * runtime. Module instances that were replaced stay in memory (Node has no public eviction API).
 * A change that keeps both the size and the modification time of a file is not detected.
 * Requires the Host to have registered tsx for `.ts` entries.
 */
export const processPluginModules: PluginModules = makePluginModules(undefined)

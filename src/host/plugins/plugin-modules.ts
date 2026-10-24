// @effect-diagnostics-next-line nodeBuiltinImport:off -- the resolve hook Node calls is synchronous, so it cannot run an Effect FileSystem call.
import { existsSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PluginRestartRequiredError } from '@shared/plugin/plugin-registry'
import { Effect, Exit } from 'effect'
import { ModuleGenerations } from './module-generations'

/**
 * How the Host imports plugin code. `importEntry` imports the module at the absolute path
 * `entry`, which lies inside the plugin directory `root`, and returns its namespace. `transact`
 * runs `use`, which imports plugin code, as one reload of the plugin at `root`: modules whose
 * source changed since the last reload evaluate again together with the modules that import
 * them, and the rest keep their evaluated instance. When `use` fails the module state is restored
 * to what it was before `transact`. `transact` fails with {@link PluginRestartRequiredError}
 * without running `use` when a file outside `root` that a plugin module imports directly has
 * changed, because such a file cannot be evaluated again in this process. Callers must not run
 * two `transact` calls at the same time.
 */
export interface PluginModules {
  readonly transact: <A, E, R>(
    root: string,
    use: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | PluginRestartRequiredError, R>
  readonly importEntry: (root: string, entry: string) => Promise<unknown>
}

interface Signature {
  readonly size: number
  readonly mtimeMs: number
}

const SHARED_LIBRARY = /^effect(\/|$)/

const PLUGIN_API = '@dia/plugin'

const builtPluginApiUrl = (): string | undefined => {
  const url = new URL('../plugin-api.js', import.meta.url)
  return existsSync(fileURLToPath(url)) ? url.href : undefined
}

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

const makePluginModules = (pluginApiUrl: string | undefined): PluginModules => {
  const generations = new ModuleGenerations()
  const roots = new Set<string>()
  let signatures = new Map<string, Signature>()
  let externals = new Map<string, Map<string, Signature>>()
  let hooksInstalled = false

  const rootOf = (url: string | undefined): string | undefined => {
    if (url === undefined) return undefined
    for (const prefix of roots) if (url.startsWith(prefix)) return prefix
    return undefined
  }

  const record = (known: Map<string, Signature>, url: string): void => {
    if (known.has(url)) return
    const signature = signatureOf(url)
    if (signature !== undefined) known.set(url, signature)
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
        const fromHost =
          SHARED_LIBRARY.test(specifier) && parentRoot !== undefined
            ? { ...context, parentURL: import.meta.url }
            : context
        const resolved = nextResolve(specifier, fromHost)
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
    return () => {
      restoreGenerations()
      for (const [url, signature] of signatures) {
        if (!savedSignatures.has(url)) savedSignatures.set(url, signature)
      }
      signatures = savedSignatures
      externals = savedExternals
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

  const registerRoot = (root: string): string => {
    installHooks()
    const prefix = rootPrefix(root)
    roots.add(prefix)
    return prefix
  }

  const transact = <A, E, R>(
    root: string,
    use: Effect.Effect<A, E, R>
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
      const affected = generations.invalidate(changed.keys())
      for (const [url, current] of changed) {
        if (current === undefined) signatures.delete(url)
        else signatures.set(url, current)
      }
      yield* Effect.logDebug('Plugin modules invalidated', {
        root,
        changed: [...changed.keys()],
        affected: affected.size
      })

      const exit = yield* Effect.exit(use)
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

  return { transact, importEntry }
}

/**
 * The {@link PluginModules} the Host uses. One instance serves the whole process because the
 * resolution hook it installs on first use is process-wide. Imports of `effect` made from inside
 * a plugin resolve to the Host's own copy, so one copy of the library exists at runtime. Module
 * instances that were replaced stay in memory (Node has no public eviction API). A change that
 * keeps both the size and the modification time of a file is not detected. Requires the Host to
 * have registered tsx for `.ts` entries.
 */
export const processPluginModules: PluginModules = makePluginModules(builtPluginApiUrl())

import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import type { PluginMemoryGuard } from '@shared/plugin/plugin-registry'
import { Effect } from 'effect'

/**
 * Builds a {@link PluginMemoryGuard} that attributes Host heap growth to the plugin being loaded.
 * `track` reads `heapUsed` before and after the effect it wraps (failed effects included) and adds
 * the difference to the plugin's total, which never goes below 0. `limit` and `heapUsed` are in
 * bytes. Callers must not run two tracked effects at the same time, because their growth would
 * be attributed to both. Totals live in memory and restart from 0 with the process. The total is
 * an estimate: allocations made by other work while the effect runs are counted too.
 */
export const makePluginMemoryGuard = (options: {
  readonly limit: number
  readonly heapUsed: Effect.Effect<number>
}): PluginMemoryGuard => {
  const totals = new Map<string, number>()

  const used = (plugin: string): Effect.Effect<number> => Effect.sync(() => totals.get(plugin) ?? 0)

  const track = <A, E, R>(plugin: string, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const before = yield* options.heapUsed
      const exit = yield* Effect.exit(effect)
      const after = yield* options.heapUsed
      const total = Math.max(0, (totals.get(plugin) ?? 0) + after - before)
      totals.set(plugin, total)
      yield* Effect.logDebug('Plugin memory tracked', {
        plugin,
        deltaBytes: after - before,
        totalBytes: total
      })
      return yield* exit
    })

  return { limit: options.limit, used, track }
}

type Collector = (() => void) | undefined

const findCollector = (): Collector => {
  try {
    setFlagsFromString('--expose-gc')
    const collect: unknown = runInNewContext('gc')
    return typeof collect === 'function' ? (collect as () => void) : undefined
  } catch {
    return undefined
  }
}

let collector: { readonly found: Collector } | undefined

/**
 * Bytes of V8 heap in use, read right after a full garbage collection so that garbage left by
 * earlier work is not counted. The collection blocks the Host's event loop for its duration. It
 * turns on V8's `--expose-gc` flag at run time; Node documents that changing V8 flags after
 * start-up may do nothing, and whether it works in a packaged Host is unverified. When no
 * collection is possible the value is read without one and a warning is logged once, so
 * attributed growth includes garbage not yet collected.
 */
export const heapUsedAfterGc: Effect.Effect<number> = Effect.gen(function* () {
  if (collector === undefined) {
    collector = { found: findCollector() }
    if (collector.found === undefined) {
      yield* Effect.logWarning(
        'Cannot force a garbage collection; plugin memory totals include uncollected garbage'
      )
    }
  }
  collector.found?.()
  return process.memoryUsage().heapUsed
})

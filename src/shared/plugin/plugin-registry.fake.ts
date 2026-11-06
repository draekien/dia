import { Effect, Option } from 'effect'
import type { PluginRegistry } from './plugin-registry'

/**
 * A `PluginRegistry.use` for tests that runs `f` with the value `read` returns for the key, or
 * returns `None` without running `f` when `read` returns `None`. It holds no lease, so it never
 * fails with `ServiceWithdrawnError`.
 */
export const fakeUse =
  (read: (key: string) => Option.Option<unknown>): PluginRegistry['use'] =>
  (key, f) =>
    Effect.suspend(() => {
      const value = read(key)
      return Option.isSome(value) ? f(value.value).pipe(Effect.asSome) : Effect.succeedNone
    })

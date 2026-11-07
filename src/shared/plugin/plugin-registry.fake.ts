import { Effect, Option } from 'effect'
import type { AnyServiceKey } from './api'
import type { PluginRegistry } from './plugin-registry'
import { nameOf, passes } from './service-key'

const readChecked = (
  read: (key: string) => Option.Option<unknown>,
  key: AnyServiceKey
): Option.Option<unknown> => Option.filter(read(nameOf(key)), (value) => passes(key, value))

/**
 * A `PluginRegistry.inject` for tests that returns the value `read` returns for the key's name,
 * or `None` when `read` returns `None` or the value fails a `ServiceKey`'s check. It never fails
 * with `ServiceNotDeclaredError`.
 */
export const fakeInject =
  (read: (key: string) => Option.Option<unknown>): PluginRegistry['inject'] =>
  (key: AnyServiceKey) =>
    Effect.sync(() => readChecked(read, key))

/**
 * A `PluginRegistry.use` for tests that runs `f` with the value `read` returns for the key's name,
 * or returns `None` without running `f` when `read` returns `None` or the value fails a
 * `ServiceKey`'s check. It holds no lease, so it never fails with `ServiceWithdrawnError`.
 */
export const fakeUse =
  (read: (key: string) => Option.Option<unknown>): PluginRegistry['use'] =>
  <A, E, R>(key: AnyServiceKey, f: (value: unknown) => Effect.Effect<A, E, R>) =>
    Effect.suspend(() =>
      Option.match(readChecked(read, key), {
        onNone: () => Effect.succeedNone,
        onSome: (value) => f(value).pipe(Effect.asSome)
      })
    )

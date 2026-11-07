import type { PluginServices } from '@shared/plugin/api'
import {
  jsonCodec,
  PluginCallError,
  PluginCallInvalid,
  type PluginNotServing
} from '@shared/plugin/messages'
import { Effect, Schema } from 'effect'
import type { Rpc } from 'effect/rpc'

/**
 * Calls `rpc` on the `host` entry of the plugin named `ctx.name`, which serves it with
 * `ctx.serve`; declare `rpc` with `Rpc.make` in a module both entries import. Succeeds with the
 * handler's result and fails with its typed error. Fails with {@link PluginNotServing} while that
 * entry is not loaded or does not serve `rpc`, and with {@link PluginCallInvalid} when the two
 * entries disagree on `rpc`'s schemas. A defect in the handler is a defect here. Interrupting the
 * call does not stop the handler.
 */
export const callHost = <R extends Rpc.AnyWithProps>(
  ctx: Pick<PluginServices, 'name'>,
  rpc: R,
  payload: Rpc.PayloadConstructor<R>
): Effect.Effect<Rpc.Success<R>, Rpc.Error<R> | PluginNotServing | PluginCallInvalid> =>
  Effect.gen(function* () {
    const plugin = ctx.name
    const tag = rpc._tag
    const invalid = (error: Schema.SchemaError) =>
      new PluginCallInvalid({ plugin, tag, message: error.message })
    const decodeJson = (schema: Schema.Top, value: unknown) =>
      Schema.decodeUnknownEffect(jsonCodec(schema))(value).pipe(Effect.mapError(invalid))
    const encoded = yield* Schema.encodeUnknownEffect(jsonCodec(rpc.payloadSchema))(
      rpc.payloadSchema.make(payload)
    ).pipe(Effect.mapError(invalid))
    yield* Effect.logDebug('Calling a plugin host entry', { plugin, tag })
    const result = yield* Effect.promise(() => window.dia.plugins.call(plugin, tag, encoded))
    if (result._tag === 'Success') {
      return (yield* decodeJson(rpc.successSchema, result.value)) as Rpc.Success<R>
    }
    const failure = yield* decodeJson(PluginCallError, result.error).pipe(
      Effect.map((decoded) => decoded as PluginCallError)
    )
    yield* Effect.logDebug('A plugin host call failed', { plugin, tag, reason: failure._tag })
    if (failure._tag !== 'PluginCallFailed') return yield* failure
    const error = yield* decodeJson(rpc.errorSchema, failure.error)
    return yield* Effect.fail(error as Rpc.Error<R>)
  })

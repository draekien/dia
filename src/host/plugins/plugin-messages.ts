import type { PluginServices } from '@shared/plugin/api'
import { PluginCallFailed, PluginCallInvalid, PluginNotServing } from '@shared/plugin/messages'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { Effect, Option, Predicate, Schema, type Scope } from 'effect'
import { type Rpc, RpcSchema } from 'effect/rpc'

const HANDLER = Symbol('dia/PluginCallHandler')

interface PluginCallHandler {
  readonly [HANDLER]: (
    payload: unknown
  ) => Effect.Effect<unknown, PluginCallInvalid | PluginCallFailed>
}

const isHandler = (value: unknown): value is PluginCallHandler =>
  Predicate.hasProperty(value, HANDLER) && Predicate.isFunction(value[HANDLER])

const callKey = (plugin: string, tag: string): string => `call:${plugin}.${tag}`

type AnyCodec = Schema.Codec<unknown, unknown>

const jsonCodec = (schema: Schema.Top): AnyCodec => Schema.toCodecJson(schema as AnyCodec)

/**
 * Serves `rpc` for calls from the `renderer` entry of the plugin `services` belongs to, until the
 * scope it runs in closes. `served` holds the tags this plugin serves in open scopes; create one
 * per plugin open. Serving a tag already in `served`, a streaming `rpc`, or a tag another plugin
 * has taken is a defect.
 */
export const servePluginCall = <R extends Rpc.AnyWithProps>(
  services: PluginServices,
  served: Set<string>,
  rpc: R,
  handler: (payload: Rpc.Payload<R>) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const plugin = services.name
    const tag = rpc._tag
    if (RpcSchema.isStreamSchema(rpc.successSchema)) {
      return yield* Effect.die(new Error(`Plugin ${plugin} cannot serve the streaming call ${tag}`))
    }
    if (served.has(tag)) {
      return yield* Effect.die(new Error(`Plugin ${plugin} already serves ${tag}`))
    }
    const invalid = (error: Schema.SchemaError) =>
      new PluginCallInvalid({ plugin, tag, message: error.message })
    const decodePayload = Schema.decodeUnknownEffect(jsonCodec(rpc.payloadSchema))
    const encodeSuccess = Schema.encodeUnknownEffect(jsonCodec(rpc.successSchema))
    const encodeError = Schema.encodeUnknownEffect(jsonCodec(rpc.errorSchema))
    const run = (payload: unknown) =>
      Effect.gen(function* () {
        const decoded = yield* decodePayload(payload).pipe(Effect.mapError(invalid))
        return yield* handler(decoded as Rpc.Payload<R>).pipe(
          Effect.matchEffect({
            onSuccess: (value) => encodeSuccess(value).pipe(Effect.mapError(invalid)),
            onFailure: (error) =>
              encodeError(error).pipe(
                Effect.mapError(invalid),
                Effect.flatMap((encoded) => Effect.fail(new PluginCallFailed({ error: encoded })))
              )
          })
        )
      })
    const value: PluginCallHandler = { [HANDLER]: run }
    yield* Effect.acquireRelease(
      Effect.sync(() => served.add(tag)),
      () => Effect.sync(() => served.delete(tag))
    )
    yield* services.provide(callKey(plugin, tag), value).pipe(Effect.orDie)
    yield* Effect.logDebug('Serving a plugin call', { plugin, tag })
  })

/**
 * Runs the handler plugin `plugin` serves for `tag` with `payload`, holding the plugin open until
 * the handler ends (ADR-0055). Fails with {@link PluginNotServing} when no handler is served or the
 * plugin closed during the call, with {@link PluginCallInvalid} when `payload` or the result does
 * not match the call's schema, and with {@link PluginCallFailed} carrying the handler's encoded
 * error.
 */
export const callPlugin = Effect.fn('PluginMessages.call')(function* (
  registry: Pick<PluginRegistry, 'use'>,
  request: { readonly plugin: string; readonly tag: string; readonly payload: unknown }
) {
  const { plugin, tag, payload } = request
  const notServing = (message: string) => new PluginNotServing({ plugin, tag, message })
  const result = yield* registry
    .use(
      callKey(plugin, tag),
      (value): Effect.Effect<unknown, PluginNotServing | PluginCallInvalid | PluginCallFailed> =>
        isHandler(value)
          ? value[HANDLER](payload)
          : Effect.fail(notServing(`Plugin ${plugin} does not serve ${tag}`))
    )
    .pipe(
      Effect.catchTag('ServiceWithdrawnError', (error) => Effect.fail(notServing(error.message)))
    )
  if (Option.isNone(result)) {
    yield* Effect.logDebug('A plugin call found no handler', { plugin, tag })
    return yield* notServing(`Plugin ${plugin} does not serve ${tag}`)
  }
  return result.value
})

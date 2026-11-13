import type { PluginServices } from '@shared/plugin/api'
import {
  jsonCodec,
  type PluginCallAttempt,
  type PluginCallError,
  PluginCallFailed,
  PluginCallInvalid,
  PluginNotServing
} from '@shared/plugin/messages'
import { type PluginRegistry, SERVICE_USE_TIME_LIMIT } from '@shared/plugin/plugin-registry'
import { Deferred, Effect, Option, Predicate, Schema, type Scope, Stream } from 'effect'
import { type Rpc, RpcSchema } from 'effect/rpc'

const HANDLER = Symbol('dia/PluginCallHandler')

interface PluginCallHandler {
  readonly [HANDLER]: (
    payload: unknown,
    call: PluginCallAttempt
  ) => Effect.Effect<unknown, PluginCallInvalid | PluginCallFailed>
}

const isHandler = (value: unknown): value is PluginCallHandler =>
  Predicate.hasProperty(value, HANDLER) && Predicate.isFunction(value[HANDLER])

const STREAM_HANDLER = Symbol('dia/PluginStreamHandler')

interface PluginStreamHandler {
  readonly [STREAM_HANDLER]: (
    payload: unknown
  ) => Stream.Stream<unknown, PluginNotServing | PluginCallInvalid | PluginCallFailed>
}

const isStreamHandler = (value: unknown): value is PluginStreamHandler =>
  Predicate.hasProperty(value, STREAM_HANDLER) && Predicate.isFunction(value[STREAM_HANDLER])

interface SubscriptionTracker {
  readonly guard: <A, E>(stream: Stream.Stream<A, E>) => Stream.Stream<A, E | PluginNotServing>
  readonly close: Effect.Effect<void>
}

const makeSubscriptionTracker = (plugin: string, tag: string): Effect.Effect<SubscriptionTracker> =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>()
    const drained = yield* Deferred.make<void>()
    let running = 0
    const notServing = new PluginNotServing({
      plugin,
      tag,
      message: `Plugin ${plugin} stopped serving ${tag}`
    })
    const release = Effect.suspend(() => {
      running -= 1
      return running === 0 && Deferred.isDoneUnsafe(closed)
        ? Deferred.succeed(drained, undefined)
        : Effect.void
    })
    const guard: SubscriptionTracker['guard'] = (stream) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (Deferred.isDoneUnsafe(closed)) return Stream.fail(notServing)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              running += 1
            }),
            () => release
          )
          return stream.pipe(
            Stream.interruptWhen(Deferred.await(closed)),
            Stream.concat(
              Stream.unwrap(
                Effect.map(Deferred.isDone(closed), (done) =>
                  done ? Stream.fail(notServing) : Stream.empty
                )
              )
            )
          )
        })
      )
    const close = Effect.gen(function* () {
      yield* Deferred.succeed(closed, undefined)
      if (running === 0) return
      yield* Effect.logInfo('Waiting for plugin subscriptions to end', {
        plugin,
        tag,
        running
      })
      const ended = yield* Effect.interruptible(
        Deferred.await(drained).pipe(Effect.timeoutOption(SERVICE_USE_TIME_LIMIT))
      )
      if (Option.isNone(ended)) {
        yield* Effect.logWarning('Plugin subscriptions did not end before the time limit', {
          plugin,
          tag,
          remaining: running
        })
      }
    })
    return { guard, close }
  })

const callKey = (plugin: string, tag: string): string => `call:${plugin}.${tag}`

/**
 * Serves `rpc` for calls from the `renderer` entry of the plugin `services` belongs to, until the
 * scope it runs in closes. `served` holds the tags this plugin serves in open scopes; create one
 * per plugin open. A request/response `rpc` takes a handler returning an effect and is run by
 * {@link callPlugin}; a streaming `rpc` takes a handler returning a stream and is run by
 * {@link subscribePlugin}; only a request/response handler receives `call`. Closing the scope ends every subscription of a streaming tag with
 * {@link PluginNotServing} and waits for them to end, up to the registry's service time limit.
 * Serving a tag already in `served`, or a tag another plugin has taken, is a defect.
 */
export const servePluginCall = <R extends Rpc.AnyWithProps>(
  services: PluginServices,
  served: Set<string>,
  rpc: R,
  handler: (
    payload: Rpc.Payload<R>,
    call: PluginCallAttempt
  ) =>
    | Effect.Effect<Rpc.Success<R>, Rpc.Error<R>>
    | Stream.Stream<Rpc.SuccessChunk<R>, Rpc.ErrorExit<R>>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const plugin = services.name
    const tag = rpc._tag
    if (served.has(tag)) {
      return yield* Effect.die(new Error(`Plugin ${plugin} already serves ${tag}`))
    }
    const invalid = (error: Schema.SchemaError) =>
      new PluginCallInvalid({ plugin, tag, message: error.message })
    const decodePayload = Schema.decodeUnknownEffect(jsonCodec(rpc.payloadSchema))
    const streamSchema = RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema : undefined
    const encodeError = (schema: Schema.Top) => Schema.encodeUnknownEffect(jsonCodec(schema))
    const failEncoded = (encode: ReturnType<typeof encodeError>) => (error: unknown) =>
      encode(error).pipe(
        Effect.mapError(invalid),
        Effect.flatMap((encoded) => Effect.fail(new PluginCallFailed({ error: encoded })))
      )

    let value: PluginCallHandler | PluginStreamHandler
    let tracker: SubscriptionTracker | undefined
    if (streamSchema !== undefined) {
      const encodeValue = Schema.encodeUnknownEffect(jsonCodec(streamSchema.success))
      const failHandlerError = failEncoded(encodeError(streamSchema.error))
      const streamHandler = handler as (payload: Rpc.Payload<R>) => Stream.Stream<unknown, unknown>
      const subscribed = yield* makeSubscriptionTracker(plugin, tag)
      tracker = subscribed
      value = {
        [STREAM_HANDLER]: (payload) =>
          subscribed.guard(
            Stream.unwrap(
              decodePayload(payload).pipe(
                Effect.mapError(invalid),
                Effect.map((decoded) =>
                  streamHandler(decoded as Rpc.Payload<R>).pipe(
                    Stream.catch((error) => Stream.fromEffect(failHandlerError(error))),
                    Stream.mapEffect((item) => encodeValue(item).pipe(Effect.mapError(invalid)))
                  )
                )
              )
            )
          )
      }
    } else {
      const encodeSuccess = Schema.encodeUnknownEffect(jsonCodec(rpc.successSchema))
      const failHandlerError = failEncoded(encodeError(rpc.errorSchema))
      const effectHandler = handler as (
        payload: Rpc.Payload<R>,
        call: PluginCallAttempt
      ) => Effect.Effect<unknown, unknown>
      value = {
        [HANDLER]: (payload, call) =>
          Effect.gen(function* () {
            const decoded = yield* decodePayload(payload).pipe(Effect.mapError(invalid))
            return yield* effectHandler(decoded as Rpc.Payload<R>, call).pipe(
              Effect.matchEffect({
                onSuccess: (item) => encodeSuccess(item).pipe(Effect.mapError(invalid)),
                onFailure: failHandlerError
              })
            )
          })
      }
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => served.add(tag)),
      () => Effect.sync(() => served.delete(tag))
    )
    yield* services.provide(callKey(plugin, tag), value).pipe(Effect.orDie)
    if (tracker !== undefined) yield* Effect.addFinalizer(() => tracker.close)
    yield* Effect.logDebug('Serving a plugin call', {
      plugin,
      tag,
      streaming: tracker !== undefined
    })
  })

/**
 * Runs the handler plugin `plugin` serves for `tag` with `payload` and `call`, holding the plugin open until
 * the handler ends (ADR-0055). Fails with {@link PluginNotServing} when no handler is served or the
 * plugin closed during the call, with {@link PluginCallInvalid} when `payload` or the result does
 * not match the call's schema, and with {@link PluginCallFailed} carrying the handler's encoded
 * error.
 */
export const callPlugin = Effect.fn('PluginMessages.call')(function* (
  registry: Pick<PluginRegistry, 'use'>,
  request: {
    readonly plugin: string
    readonly tag: string
    readonly payload: unknown
    readonly call: PluginCallAttempt
  }
) {
  const { plugin, tag, payload, call } = request
  const notServing = (message: string) => new PluginNotServing({ plugin, tag, message })
  yield* Effect.logDebug('Running a plugin call', { plugin, tag, id: call.id, resent: call.resent })
  const result = yield* registry
    .use(
      callKey(plugin, tag),
      (value): Effect.Effect<unknown, PluginNotServing | PluginCallInvalid | PluginCallFailed> =>
        isHandler(value)
          ? value[HANDLER](payload, call)
          : isStreamHandler(value)
            ? Effect.fail(
                new PluginCallInvalid({ plugin, tag, message: `\`${tag}\` is a streaming call` })
              )
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

/**
 * Starts the streaming call plugin `plugin` serves for `tag` with `payload`, an encoded value.
 * Succeeds with a stream of encoded values; it holds no lease on the plugin, so it never delays a
 * reload (ADR-0068). The stream completes when the handler's stream completes, and fails with
 * {@link PluginCallFailed} carrying the handler's encoded error, with {@link PluginCallInvalid}
 * when `payload` or a value does not match the call's schema, and with {@link PluginNotServing}
 * when the plugin closes while it runs or when it is already closed. Fails with
 * {@link PluginNotServing} before the stream starts when no handler is served, and with
 * {@link PluginCallInvalid} when `tag` is not a streaming call.
 */
export const subscribePlugin = Effect.fn('PluginMessages.subscribe')(function* (
  registry: Pick<PluginRegistry, 'use'>,
  request: { readonly plugin: string; readonly tag: string; readonly payload: unknown }
) {
  const { plugin, tag, payload } = request
  const notServing = (message: string) => new PluginNotServing({ plugin, tag, message })
  const found = yield* registry
    .use(
      callKey(plugin, tag),
      (
        value
      ): Effect.Effect<
        Stream.Stream<unknown, PluginCallError>,
        PluginNotServing | PluginCallInvalid
      > =>
        isStreamHandler(value)
          ? Effect.succeed(value[STREAM_HANDLER](payload))
          : isHandler(value)
            ? Effect.fail(
                new PluginCallInvalid({
                  plugin,
                  tag,
                  message: `\`${tag}\` is not a streaming call`
                })
              )
            : Effect.fail(notServing(`Plugin ${plugin} does not serve ${tag}`))
    )
    .pipe(
      Effect.catchTag('ServiceWithdrawnError', (error) => Effect.fail(notServing(error.message)))
    )
  if (Option.isNone(found)) {
    yield* Effect.logDebug('A plugin subscription found no handler', { plugin, tag })
    return yield* notServing(`Plugin ${plugin} does not serve ${tag}`)
  }
  yield* Effect.logDebug('A plugin subscription started', { plugin, tag })
  return found.value
})

import type { PluginServices } from '@shared/plugin/api'
import {
  jsonCodec,
  PluginCallError,
  PluginCallInvalid,
  type PluginNotServing
} from '@shared/plugin/messages'
import { Cause, Data, Duration, Effect, Option, Predicate, Queue, Schema, Stream } from 'effect'
import { type Rpc, RpcSchema } from 'effect/rpc'

const PLUGIN_RETRY_INTERVAL = Duration.seconds(5)

class SubscriptionFailed extends Data.TaggedError('SubscriptionFailed')<{
  readonly error: unknown
}> {}

const invalidOf = (plugin: string, tag: string) => (error: Schema.SchemaError) =>
  new PluginCallInvalid({ plugin, tag, message: error.message })

const decodeJson = (plugin: string, tag: string, schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownEffect(jsonCodec(schema))(value).pipe(Effect.mapError(invalidOf(plugin, tag)))

const failFromWire = <E>(
  plugin: string,
  tag: string,
  errorSchema: Schema.Top,
  wire: unknown
): Effect.Effect<never, E | PluginNotServing | PluginCallInvalid> =>
  Effect.gen(function* () {
    const failure = (yield* decodeJson(plugin, tag, PluginCallError, wire)) as PluginCallError
    yield* Effect.logDebug('A plugin host call failed', { plugin, tag, reason: failure._tag })
    if (failure._tag !== 'PluginCallFailed') return yield* failure
    const error = yield* decodeJson(plugin, tag, errorSchema, failure.error)
    return yield* Effect.fail(error as E)
  })

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
    const invalid = invalidOf(plugin, tag)
    const encoded = yield* Schema.encodeUnknownEffect(jsonCodec(rpc.payloadSchema))(
      rpc.payloadSchema.make(payload)
    ).pipe(Effect.mapError(invalid))
    yield* Effect.logDebug('Calling a plugin host entry', { plugin, tag })
    const result = yield* Effect.promise(() => window.dia.plugins.call(plugin, tag, encoded))
    if (result._tag === 'Success') {
      return (yield* decodeJson(plugin, tag, rpc.successSchema, result.value)) as Rpc.Success<R>
    }
    return yield* failFromWire<Rpc.Error<R>>(plugin, tag, rpc.errorSchema, result.error)
  })

const subscribeHost = (
  plugin: string,
  tag: string,
  encodedPayload: unknown
): Stream.Stream<unknown, SubscriptionFailed> =>
  Stream.callback<unknown, SubscriptionFailed>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        window.dia.plugins.subscribe(
          plugin,
          tag,
          encodedPayload,
          (value) => void Queue.offerUnsafe(queue, value),
          (end) =>
            void (end._tag === 'PluginSubscriptionDone'
              ? Queue.endUnsafe(queue)
              : Queue.failCauseUnsafe(
                  queue,
                  Cause.fail(new SubscriptionFailed({ error: end.error }))
                ))
        )
      ),
      (unsubscribe) => Effect.sync(unsubscribe)
    )
  )

const untilPluginStatusChanges = (name: string) =>
  Effect.race(
    Effect.callback<void>((resume) => {
      const stop = window.dia.plugins.onStatusChanged((event) => {
        if (event.name === name) resume(Effect.void)
      })
      return Effect.sync(stop)
    }),
    Effect.sleep(PLUGIN_RETRY_INTERVAL)
  )

/**
 * Follows the streaming `rpc` that the `host` entry of the plugin named `ctx.name` serves with
 * `ctx.serve`; declare `rpc` with `Rpc.make(tag, { ..., stream: true })` in a module both entries
 * import. Emits `Some(value)` for each value the handler's stream produces, starting with the
 * current state, and `None` while that entry is not serving `rpc`, then subscribes again after the
 * plugin's next status change or after 5 seconds, whichever is first. Completes when the
 * handler's stream completes, and fails with the handler's typed error, or with
 * {@link PluginCallInvalid} when the two entries disagree on `rpc`'s schemas or `payload` does
 * not encode. Interrupting the stream ends the subscription.
 */
export const followHost = <R extends Rpc.AnyWithProps>(
  ctx: Pick<PluginServices, 'name'>,
  rpc: R,
  payload: Rpc.PayloadConstructor<R>
): Stream.Stream<Option.Option<Rpc.SuccessChunk<R>>, Rpc.ErrorExit<R> | PluginCallInvalid> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const plugin = ctx.name
      const tag = rpc._tag
      const streamSchema = RpcSchema.isStreamSchema(rpc.successSchema)
        ? rpc.successSchema
        : undefined
      if (streamSchema === undefined) {
        return Stream.fail(
          new PluginCallInvalid({ plugin, tag, message: `\`${tag}\` is not a streaming call` })
        )
      }
      const encoded = yield* Schema.encodeUnknownEffect(jsonCodec(rpc.payloadSchema))(
        rpc.payloadSchema.make(payload)
      ).pipe(Effect.mapError(invalidOf(plugin, tag)))
      const follow = (
        announce: boolean
      ): Stream.Stream<Option.Option<Rpc.SuccessChunk<R>>, unknown> =>
        Stream.suspend(() => {
          let received = false
          return subscribeHost(plugin, tag, encoded).pipe(
            Stream.mapEffect((value) => decodeJson(plugin, tag, streamSchema.success, value)),
            Stream.tap(() =>
              received
                ? Effect.void
                : Effect.suspend(() => {
                    received = true
                    return Effect.logDebug('A plugin host entry is serving', { plugin, tag })
                  })
            ),
            Stream.map((value) => Option.some(value as Rpc.SuccessChunk<R>)),
            Stream.catchTag('SubscriptionFailed', (failed) =>
              Stream.unwrap(
                failFromWire<unknown>(plugin, tag, streamSchema.error, failed.error).pipe(
                  Effect.catch(
                    (
                      error
                    ): Effect.Effect<
                      Stream.Stream<Option.Option<Rpc.SuccessChunk<R>>, unknown>,
                      unknown
                    > =>
                      Predicate.isTagged(error, 'PluginNotServing')
                        ? Effect.logDebug('A plugin host entry is not serving', {
                            plugin,
                            tag
                          }).pipe(
                            Effect.as(
                              (announce || received
                                ? Stream.make(Option.none<Rpc.SuccessChunk<R>>())
                                : Stream.empty
                              ).pipe(
                                Stream.concat(
                                  Stream.fromEffect(untilPluginStatusChanges(plugin)).pipe(
                                    Stream.drain
                                  )
                                ),
                                Stream.concat(follow(false))
                              )
                            )
                          )
                        : Effect.fail(error)
                  )
                )
              )
            )
          )
        })
      return follow(true).pipe(
        Stream.mapError((error) => error as Rpc.ErrorExit<R> | PluginCallInvalid)
      )
    })
  )

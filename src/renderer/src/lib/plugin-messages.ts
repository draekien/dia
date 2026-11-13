import type { PluginServices } from '@shared/plugin/api'
import { PluginName } from '@shared/plugin/manifest'
import {
  jsonCodec,
  PluginCallError,
  PluginCallInvalid,
  type PluginNotServing
} from '@shared/plugin/messages'
import { Cause, Data, Duration, Effect, Option, Predicate, Queue, Schema, Stream } from 'effect'
import { type Rpc, RpcSchema } from 'effect/rpc'

const PLUGIN_RETRY_INTERVAL = Duration.seconds(5)

/**
 * The plugin whose `host` entry serves a call: its name, such as `'dia-runs'`, or a plugin
 * context, which names the caller's own plugin.
 */
export type PluginTarget = string | Pick<PluginServices, 'name'>

class SubscriptionFailed extends Data.TaggedError('SubscriptionFailed')<{
  readonly error: unknown
}> {}

const invalidOf = (plugin: string, tag: string) => (error: Schema.SchemaError) =>
  new PluginCallInvalid({ plugin, tag, message: error.message })

const pluginOf = (target: PluginTarget, tag: string): Effect.Effect<string, PluginCallInvalid> => {
  const name = typeof target === 'string' ? target : target.name
  return Schema.decodeUnknownEffect(PluginName)(name).pipe(
    Effect.mapError(
      (error) =>
        new PluginCallInvalid(
          { plugin: name, tag, message: error.message },
          { disableChecks: true }
        )
    )
  )
}

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
 * Calls `rpc` on the `host` entry of the plugin `target` names, which serves it with
 * `ctx.serve`; declare `rpc` with `Rpc.make` in a module both entries import. To call another
 * plugin, import `rpc` from that plugin's exported module (`@dia-plugin/<name>/<file>`) and pass
 * its name. The handler sees a call the preload resends after a lost connection as a resend of
 * the same call (`PluginCallAttempt`). Succeeds with the handler's result and fails with its
 * typed error. Fails with {@link PluginNotServing} while that entry is not loaded or does not
 * serve `rpc`, and with {@link PluginCallInvalid} when `target` is not a valid plugin name or the
 * two entries disagree on `rpc`'s schemas. A defect in the handler is a defect here.
 * Interrupting the call does not stop the handler.
 */
export const callHost = <R extends Rpc.AnyWithProps>(
  target: PluginTarget,
  rpc: R,
  payload: Rpc.PayloadConstructor<R>
): Effect.Effect<Rpc.Success<R>, Rpc.Error<R> | PluginNotServing | PluginCallInvalid> =>
  Effect.gen(function* () {
    const tag = rpc._tag
    const plugin = yield* pluginOf(target, tag)
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
 * Follows the streaming `rpc` that the `host` entry of the plugin `target` names serves with
 * `ctx.serve`; declare `rpc` with `Rpc.make(tag, { ..., stream: true })` in a module both entries
 * import, or import it from another plugin's exported module and pass that plugin's name. Emits
 * `Some(value)` for each value the handler's stream produces, starting with the current state,
 * and `None` while that entry is not serving `rpc`, then subscribes again after the plugin's next
 * status change or after 5 seconds, whichever is first. Completes when the
 * handler's stream completes, and fails with the handler's typed error, or with
 * {@link PluginCallInvalid} when `target` is not a valid plugin name, the two entries disagree on
 * `rpc`'s schemas, or `payload` does not encode. Interrupting the stream ends the subscription.
 */
export const followHost = <R extends Rpc.AnyWithProps>(
  target: PluginTarget,
  rpc: R,
  payload: Rpc.PayloadConstructor<R>
): Stream.Stream<Option.Option<Rpc.SuccessChunk<R>>, Rpc.ErrorExit<R> | PluginCallInvalid> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const tag = rpc._tag
      const plugin = yield* pluginOf(target, tag)
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
      type Value = Option.Option<Rpc.SuccessChunk<R>>
      const subscribeOnce = (emit: (value: Value) => Effect.Effect<boolean>) =>
        Effect.gen(function* () {
          let received = false
          const served = yield* subscribeHost(plugin, tag, encoded).pipe(
            Stream.mapEffect((value) => decodeJson(plugin, tag, streamSchema.success, value)),
            Stream.runForEach((value) =>
              Effect.gen(function* () {
                if (!received) {
                  received = true
                  yield* Effect.logDebug('A plugin host entry is serving', { plugin, tag })
                }
                yield* emit(Option.some(value as Rpc.SuccessChunk<R>))
              })
            ),
            Effect.as(true),
            Effect.catchTag('SubscriptionFailed', (failed) =>
              failFromWire<unknown>(plugin, tag, streamSchema.error, failed.error).pipe(
                Effect.catch((error) =>
                  Predicate.isTagged(error, 'PluginNotServing')
                    ? Effect.succeed(false)
                    : Effect.fail(error)
                )
              )
            )
          )
          return { served, received }
        })
      const follow = Stream.callback<Value, unknown>((queue) =>
        Effect.gen(function* () {
          let announce = true
          while (true) {
            const { served, received } = yield* subscribeOnce((value) => Queue.offer(queue, value))
            if (served) return yield* Queue.end(queue)
            yield* Effect.logDebug('A plugin host entry is not serving', { plugin, tag })
            if (announce || received) yield* Queue.offer(queue, Option.none())
            announce = false
            yield* untilPluginStatusChanges(plugin)
          }
        }).pipe(Effect.catch((error) => Queue.fail(queue, error)))
      )
      return follow.pipe(Stream.mapError((error) => error as Rpc.ErrorExit<R> | PluginCallInvalid))
    })
  )

# A stream over a PubSub subscribes on its first pull, not at `Stream.toPull`

**Date:** 2026-11-13

## Context

`dia-run-messaging` reads a run's chat state and then folds the events committed after it. It followed `followRunChat` in `plugins/dia-run-events/host.ts`: `Stream.toPull(store.committed)` first, then `snapshot`, then the pulled events. A test that published an event between the snapshot and the first pull never received it, and `run_delegate` waited for its 30-second limit.

## Reasoning / Learning

`Stream.fromPubSub` is `Channel.fromPubSubArray`, which is `Channel.unwrap(Effect.map(PubSub.subscribe(pubsub), …))`. `Channel.unwrap` runs that effect inside the returned pull on its first call (`node_modules/effect/src/Channel.ts`, `unwrap`). `Stream.toPull` builds the pull without calling it. So the `PubSub.subscribe` happens when something first pulls, and every event published before then is lost to that reader.

`PubSub.subscribe` is scoped and subscribes at once; `Stream.fromSubscription` turns the subscription into a stream. `RunEventStore.subscribe` and `RunEvents.subscribe` return that, and `followRunChat` now uses it.

## Implication

To read state and then follow the events after it, subscribe with `RunEvents.subscribe` (or `PubSub.subscribe`) before reading the state. Do not rely on `Stream.toPull` of a PubSub-backed stream to subscribe.

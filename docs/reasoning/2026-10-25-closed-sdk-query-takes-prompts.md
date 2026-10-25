# A closed SDK query keeps reading the pane's prompt queue

**Date:** 2026-10-25

## Context

In the unpackaged app, a rewind restored the files but the next prompt was never answered, and the pane kept the pre-rewind session id. The Agent SDK was not at fault: a standalone script with the same options (`resume`, `resumeSessionAt`, `forkSession`, streaming input, `replay-user-messages`) forked and answered, also with the prompt sent 15 s after the query started. The cause was in `plugins/claude-code/session.ts`, which runs a pane as a sequence of SDK queries (pane open, each thinking-level change, each rewind).

## Reasoning / Learning

- **The SDK never ends its prompt loop on `close()`.** `Query.streamInput` in `@anthropic-ai/claude-agent-sdk` 0.3.207 is `for await (const r of prompt) { if (aborted) break; write(r) }`. `close()` aborts but cannot end a pending `next()`. When that `next()` later yields a prompt, the loop sees the abort, breaks, and the prompt is dropped.
- **Every query read one shared queue.** Each query's prompt was `Stream.toAsyncIterable(Stream.fromQueue(promptQueue))` over the session's one `promptQueue`. A closed query's pending `next()` stayed registered on that queue for the life of the pane. A probe that logged which query received each prompt showed turn 3 going to the query the rewind had closed, and a later prompt going to the forked query of an earlier rewind, closed 2 minutes before. Two thinking-level restarts delivered their prompt correctly, so which reader receives a prompt depends on scheduling.
- **`Stream.fromQueue` + `Stream.interruptWhen` does not fix it.** `interruptWhen` merges the stream with eager forks (effect `Channel.ts`, `interruptWhen` and `merge`), so the queue side takes the next prompt while the SDK is still writing the previous one, and drops it when the stream ends. A test also showed it delivering a queued prompt after the end signal. `openPromptInput` instead takes exactly one prompt per `next()`, racing `Queue.take` against an `ended` deferred; an interrupted `Queue.take` removes its taker without taking an item. The query's release runs `input.end` before `live.close()`, because a scope finalizer registered earlier would run after `live.close()`.
- **The reducer forgot the rewind anchor at every restart.** `makeSessionEventReducer()` was created per query with no last assistant uuid, so the first user turn after a rewind, a thinking change or a relaunch had no `resumeAnchorUuid`, and rewinding that turn started an empty session. The reducer now takes `continuesFrom`: the fork's `branchAt`, or the last assistant uuid in the transcript being resumed (`readLastAssistantUuid`). The anchor is read from the transcript and not carried over from the old reducer, because `resumeSessionAt` needs a uuid that exists in the resumed transcript, and the old reducer can hold the uuid of a message streamed mid-turn but never written.
- **A forked transcript keeps the original uuids.** The fork's `.jsonl` contains the parent's user and assistant uuids up to `branchAt`, so `branchAt` is a valid anchor for the first turn of the fork.

## Implication

- Any new restart path in `session.ts` gets both fixes by going through `startQuery`; do not create an SDK `query()` outside `runSession`.
- When a dia feature hands an async iterable to the SDK, end the iterable in the same release that closes the query, before `close()`.
- To trace prompt delivery in the running app, write from inside the iterable's `next()` to a file. `Stream.toAsyncIterable` runs its pulls with an empty context, so an `Effect.logInfo` inside them did not reach `dia.log`, and the Host's stdout did not reach the shell that launched `electron .`.

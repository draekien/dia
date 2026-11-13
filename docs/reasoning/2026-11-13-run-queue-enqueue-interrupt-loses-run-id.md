# Interrupting `RunQueue.enqueue` after the pick loses the run id

**Date:** 2026-11-13

## Context

`dia-org` first planned to interrupt the fiber waiting on `queue.enqueue` when the issue left `todo` while queued. `RunQueue.enqueue` (`plugins/dia-run-queue/run-queue.ts`) documents that an interrupt before the pick removes the entry and that, once picked, it "waits for the start and returns the id".

## Reasoning / Learning

The id cannot reach an interrupted caller. `enqueue` waits in `Effect.uninterruptibleMask`, catches the interrupt, and awaits the start again uninterruptibly, so the run does start and `enqueue`'s own effect completes with the id. When that effect returns to an interruptible region of the caller, the pending interrupt fires at once, and the caller's fiber ends `Interrupted`. This holds for a fiber whose whole body is `enqueue` (`Fiber.await` gives a `Failure` with an `Interrupt` reason) and for `Effect.uninterruptibleMask((restore) => Effect.exit(restore(enqueue)))`, where `Effect.exit` also sees the interrupt and not the id. A node probe with a `Deferred` standing in for the start confirmed both.

## Implication

A caller that must know which run started cannot cancel by interrupting `enqueue`. `dia-org` lets the wait finish and closes the run when `markStarted` refuses it (`docs/designs/dia-org.md`, D3). A caller that only needs to withdraw an unpicked entry can still interrupt. Returning the id to an interrupted caller would need `enqueue` to take a callback, or the queue to record started runs by a caller key.

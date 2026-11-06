# `Effect.timeout` waits for an uninterruptible effect; a detached fiber does not

**Date:** 2026-11-06

## Context

Issue #185 adds a time limit to a plugin's entry import and to its setup (`withinTimeLimit` in `src/shared/plugin/plugin-registry.ts`). A setup can hang inside an uninterruptible region, for example a hung `acquireRelease` acquire.

## Reasoning / Learning

- `Effect.timeout` and `Effect.timeoutOption` race the effect against a sleep with `raceFirst`. `raceFirst` returns only after the losing fiber has finished interrupting. A scratch test showed `Effect.timeout(Effect.uninterruptible(Effect.never), 10)` had not returned after 300 ms.
- Running the effect with `Effect.forkDetach` and applying the timeout to `Fiber.await(fiber)` returns at the limit, because `Fiber.await` is interruptible. The stage fiber is then interrupted without waiting, through `Effect.forkDetach(Fiber.interrupt(fiber))` in the release of `acquireUseRelease`.
- `Effect.forkDetach` without `{ startImmediately: true }` schedules the start of the fiber on the dispatcher. Under `TestClock`, a `TestClock.adjust` that runs before that start does not wake the sleeps the fiber registers later. The existing test "runs concurrent loads one after another" hung with `TestClock.adjust(Duration.seconds(2))` until the fork was given `{ startImmediately: true }`.

## Implication

To time out work that may be uninterruptible, fork it detached and time out the wait, not the work. Fork it with `{ startImmediately: true }` so `TestClock` tests that drive it with one `adjust` stay deterministic.

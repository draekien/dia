# `dia-run-queue` plugin

Issue: draekien/dia#245, step 7 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0076 ("Run queue" row).

`dia-run-queue` starts runs with no tab in order, holding back a start while the number of busy runs is at the queue's limit. A run is busy while a turn is in progress and no request of it is open, or while it has background tasks running. Every live run counts, with or without a tab, so the user's own chats hold back queued starts; ADR-0076's limit counts runs doing work, not runs the queue started. A caller can also limit how many busy runs share a key (for example one per hire), and give a start a priority. It replaces `nextStarts` (`archive/org/scheduler.ts`), whose caps counted started issues of org only.

## Success criteria

1. With a limit of 2, a run waiting for the user does not hold a slot. (Test: two queued runs start; one raises a request; a third queued run starts.)
2. A third queued run starts when a turn ends. (Test: limit 2, three entries; the third starts once one of the first two goes idle.)
3. A per-key limit of 1 keeps a second run with the same key queued. (Test: limit 2, two entries with key `h`, limit 1; the second stays queued while the first is busy, and starts when it goes idle.)
4. A run whose request was answered resumes ahead of queued runs. (Test: limit 1; run A raises a request, queued B starts, C is queued; A is answered and busy again; when B's turn ends, C stays queued until A's turn ends.)
5. A higher-priority run starts first. (Test: limit 1 with one busy run; entries of priority 0 then 5 are queued; when the busy run goes idle, the priority-5 entry starts.)

Supporting tests: a run `Runs.start` returned is in `busy` before its session reports a turn (`run-registry.test.ts`); interrupting `enqueue` before its start removes the entry; a `busy` change during a pass is followed by another pass; entries wait while no `dia-runs` provides `RunsKey` and start once one does; `RunsKey` rejects a value without `busy`.

## Decisions taken without the user

D1. **A plugin of its own, `plugins/dia-run-queue`**, not part of `dia-runs`. ADR-0076 makes each capability a plugin, and the queue only composes `Runs.start` with `Runs.busy`; `dia-runs` stays the owner of sessions. Alternative: a `queue` member of `Runs` (rejected: it couples the run lifecycle to start ordering, and reloading one reloads the other).

D2. **`dia-runs` reports which runs are busy: `Runs.busy`**, a stream of the ids of live runs whose status is `running` (a turn in progress, no open request) or that have one or more background tasks (`BackgroundTasksChanged`, whose list replaces the previous one: the Agent SDK's `background_tasks_changed` carries "every live background task after the change", `sdk.d.ts`). It emits only when the set of ids changes. The registry builds it from a `SubscriptionRef`, so a new subscriber's first element is the current set. The queue cannot derive this from `Runs.list` (no background tasks, no change notification) or from `awaitIdle` (it completes only when no turn is in progress, so a waiting run would hold its slot). Alternative: report each run's raw status and task count and let the queue decide (rejected: the only reader needs the busy set).

D3. **`Runs.start` counts its new run as busy before sending its first message**, in memory only (the row is not written). The session reports `UserMessagesSent` later; without this, `start` returns before the run is busy and the queue starts more runs than its limit in that gap. The next status the session reports replaces the mark; a failed first send and the run's teardown clear it. Opening a run whose row says `running` and has a session id (recovery, or `send` to a cold run: the `continueTurn` branch of `run-registry.ts`) seeds the same mark, because that run resumes its turn with `continue`. The mark matters to the queue's own `start` calls, which are serial; another caller of `Runs.start` gets the same mark. Alternative: the queue counts a started run as busy until it first appears in `busy` (rejected: a run whose session fails before its first turn would hold its slot until the queue stops). Alternative: mark the row `running` (rejected: a reload in the gap would send `continue` to a resumed conversation, against D8 of `docs/designs/dia-runs.md`).

Accepted gaps, each lasting one session event: when a turn ends with a message held in the run's message queue, the run is idle until the held message is sent; a `steer` or `sendQueuedNow` reaches `running` only at `UserMessagesSent`. A pass in such a gap can start one run over the limit. Closing them needs `dia-runs` to know about held messages, which no criterion requires.

D4. **An answered request is not held by the queue.** `Runs.answer` resumes the run at once, so it resumes ahead of every queued run, and the queue starts nothing while the busy count, which now includes the resumed run, is at the limit. The busy count can exceed the limit by the number of runs answered while it was full. Alternative: route answers through the queue and resume them first when a slot frees (the old scheduler's rule, cap + 1) (rejected: the user would answer in a tab or the inbox and see nothing happen).

D5. **The queue is held in memory, for the life of `dia-run-queue`.** Entries, the started runs' keys and the limit survive a reload of `dia-runs`: while no provider of `RunsKey` exists, entries wait. When `dia-run-queue` stops (reload, quit) every waiting `enqueue` is interrupted and its entry dropped. Callers own the reason a run exists and re-enqueue from it: org from its issue statuses, schedules from their catch-up rule. After a restart, runs recovered by `dia-runs` count towards the limit but not towards their key's limit. Alternative: a `queued` table in the plugin's database (rejected: no caller in steps 7–14 needs an entry to outlive its own caller).

D6. **The limit defaults to 3 and is set with `setLimit`.** No user setting is added in this step; the owner of a setting (the org rewrite, step 14, or a later settings page) calls `setLimit`. A limit below 1 counts as 1, and a fractional limit is rounded down. Alternative: a settings page and a stored limit (rejected: no screen in this step's scope).

D7. **Priority is a number, higher first, default 0; equal priorities start in enqueue order.** Org's `high | medium | low` maps to numbers at its call site. Alternative: a fixed literal set (rejected: it ties the queue to org's vocabulary).

D8. **Each entry carries its own key limit.** An entry starts only while fewer busy runs than its own `key.limit` were started with its `key.id`; entries sharing an `id` with different limits are each judged by their own. Keys are kept for the life of the queue, one string per started run, because a run that waits and is answered must count again. Alternative: a separate `setKeyLimit(id, n)` (rejected: a second piece of state per key that a caller must set before enqueueing).

## Interface

### Kernel seam (`src/host/services/runs-seam.ts`)

```ts
export interface Runs {
  // ...existing members
  /**
   * The ids of the live runs that are busy, now and after each change: a turn is in progress and
   * no request is open, or one or more background tasks run.
   */
  readonly busy: Stream.Stream<ReadonlyArray<string>>
}
```

`isRuns` also requires `busy` to be present. `PLUGIN_API_VERSION` (`src/shared/plugin/manifest.ts`, now 0.0.40) goes to 0.0.41 with every `plugin.json`. The fake `Runs` values in `src/host/services/pane-workspace.test.ts` and `plugins/dia-inbox/host.test.ts` gain `busy`; `RunsClient` does not expose it.

### Exported module (`plugins/dia-run-queue/queue.ts`, imported as `@dia-plugin/dia-run-queue/queue`)

```ts
/** A start the queue holds: `run` is passed to `Runs.start`. */
export interface QueuedRun {
  readonly run: StartRunOptions
  /** Higher starts first; default 0. */
  readonly priority?: number
  /** At most `limit` busy runs started with `id` at once. */
  readonly key?: { readonly id: string; readonly limit: number }
}

/**
 * Starts runs with no tab in priority order while fewer runs than the limit are busy. Read it
 * with `ctx.whenProvided([RunQueueKey], …)`.
 */
export interface RunQueue {
  /**
   * Queues `entry` and completes with the run's id once it started. Interrupting it before a pass
   * picks the entry removes the entry; once picked, it waits for the start and returns the id.
   */
  readonly enqueue: (entry: QueuedRun) => Effect.Effect<string>
  /** Sets how many runs may be busy before the queue holds back starts; below 1 counts as 1. */
  readonly setLimit: (limit: number) => Effect.Effect<void>
}

/** The key `dia-run-queue` provides {@link RunQueue} under: `run-queue`. A value counts when `enqueue` and `setLimit` are functions (the module-private `isRunQueue`). */
export const RunQueueKey = ServiceKey.make('run-queue', isRunQueue)
```

### Plugin internals

- `plugin.json`: `name: dia-run-queue`, `category: feature`, `host: host.ts`, `load: eager`, `exports: ["queue.ts"]`.
- `pick.ts`: `pickStarts({ limit, busy: ReadonlySet<string>, keyOf: ReadonlyMap<string, string>, queued })`, pure: sorts entries by priority (descending) then enqueue order, and picks while `busy.size + picked < limit`, skipping an entry whose key is at its limit; each pick adds to its key's count within the pass.
- `run-queue.ts`: `makeRunQueue(runs: SubscriptionRef<Option<Runs>>)`, scoped. Holds the entries (each with a `Deferred<string>`), the key of each started run and the limit. One fiber runs passes, one at a time, taking from a one-slot sliding wake-up queue; each enqueue, `setLimit`, change of the provider and `busy` change of the current provider offers to it. A trigger that arrives during a pass therefore causes one more pass, and no trigger is lost. A pass with no provider does nothing. A pass reads the current busy set (the first element of `runs.busy`), picks, removes the picked entries, and calls `runs.start` for each in order; a defect of `start` completes that entry's `Deferred` with it and the pass goes on. A pass waits for as long as `start` takes, including `dia-runs`' open lock, its worktree and its session open (accepted: no criterion needs starts in parallel). A `start` in flight when `dia-runs` reloads may die; its `enqueue` dies with it rather than being queued again, because the run may already exist. The scope's finalizer interrupts every waiting `Deferred`. Each pass logs the busy count, the picks and the entries held at debug; enqueue, a removed entry, `setLimit` and each start log at info.
- `pickStarts` and `makeRunQueue` carry JSDoc stating their contract, as every module export does.
- `host.ts`: follows `RunsKey` with `ctx.whenProvided` into a `SubscriptionRef<Option<Runs>>` (the `dia-inbox` precedent), builds the queue in the plugin's scope and provides `RunQueueKey`.

## `dia-runs` changes

- `live-run.ts`: reports the number of background tasks to a new `onBackgroundTasks` callback.
- `run-registry.ts`: keeps each live run's status and background-task count in a `SubscriptionRef`, removes the run on teardown, serves `busy` from it, marks a run `running` in it before `start` sends its first message and when it opens a run whose row says `running` (D3).

## Refinement Record

Round 1 (subagent, sonnet):

**Applied**
- *Correctness, blocker* — the queue was built inside the `whenProvided` scope of `RunsKey`, so a `dia-runs` reload dropped entries, contradicting D5 and D6. The queue now lives in the plugin's scope and reads `Runs` from a `SubscriptionRef<Option<Runs>>`.
- *Correctness, major* — marking the row `running` on send would make a reload in the gap send `continue` to a resumed conversation. D3 now marks only the in-memory busy state, only in `start`, and clears it on a failed send; the remaining one-event gaps are listed as accepted.
- *Correctness, major* — `enqueue`'s lifecycle was underspecified: defect handling, removal on interrupt, and the finalizer for waiting calls are now stated.
- *Project rules, major* — `RunQueue` had no JSDoc; logging was unspecified. Both added.
- *Correctness, minor* — `busy` was used as both a count and a set in `pickStarts`; now `ReadonlySet<string>`. Key map lifetime and per-entry limits stated (D8). `isRuns` checks `busy`. Supporting tests listed.

Round 2 (subagent, sonnet):

**Applied**
- *Correctness, major* — `start` sends through `withLive`, which swallows failures, so "a failed send clears it" was not buildable as written. The clear now runs inside the send operation, before `withLive` logs the failure; teardown also clears.
- *Correctness, major* — the wake-up guarantee was implicit. Passes now run on one fiber fed by a one-slot sliding queue, so a trigger during a pass causes another pass.
- *Correctness, major* — a recovered run is absent from `busy` until its `continue` turn reports `UserMessagesSent`. Opening a run whose row says `running` now seeds the mark.
- *Correctness, minor* — the hung-`start` risk named only the session open; it now names the open lock and worktree.
- *Project rules, minor* — JSDoc for `pickStarts` and `makeRunQueue` stated; the inline comment on `RunQueueKey` moved into its JSDoc.

**Rejected**
- *Correctness, minor, put an entry back when `start` dies during a `dia-runs` reload* — the run may already exist by then, so queuing the entry again can start it twice; the caller re-enqueues from its own state (D5).
- *Design, minor, rename `busy` to `busyRunIds`* — the JSDoc already defines busy as excluding a run waiting for the user; the stream's element type names the ids.

Round 3 (subagent, sonnet):

**Applied**
- *Correctness, major* — an `enqueue` interrupted after its entry was picked lost the run id, so a caller re-deriving from its own state would start a second run. Once picked, `enqueue` now waits for the start and returns the id.
- *Correctness, major* — seeding the busy mark for every `running` row would make a row without a session id (set `idle` by `interruptedBeforeStart`) hold a slot. The seed is now limited to the `continueTurn` branch.
- *Correctness, major* — the draft did not say whether tab runs count. Stated: every live run counts (ADR-0076 counts runs doing work).
- *Project rules, major* — the files a required `busy` member touches are now listed.
- *Correctness, minor* — `busy` emits only when the id set changes; picks count towards their key within a pass; `isRunQueue` named.

**Rejected**
- *Correctness, major, finished background tasks may stay in the list* — the Agent SDK's `SDKBackgroundTasksChangedMessage` documents "Every live background task after the change. REPLACE semantics" (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), and `dia-claude-code/reducer.ts` passes that list through.
- *Design, minor, conflicting per-key limits* — settled in D8.

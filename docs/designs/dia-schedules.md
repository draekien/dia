# `dia-schedules` plugin

Issue: draekien/dia#247, step 9 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0076 ("Schedules" row; replaces the `routines` plugin of ADR-0072).

`dia-schedules` stores schedules and starts each schedule's run through the run queue (`RunQueueKey`, `docs/designs/dia-run-queue.md`) at the schedule's times. A schedule repeats at a fixed interval or at the times of a cron expression. When one or more of its times passed while dia was closed, its catch-up rule decides whether it starts one run at once or waits for its next time.

## Success criteria

1. A schedule starts a run at its time. (Test: an interval schedule of 10 minutes enqueues nothing before 10 minutes of `TestClock` time and one entry at 10 minutes, with the schedule's run options; a cron schedule `0 9 * * *` in `UTC` enqueues at the next 09:00 UTC.)
2. A missed time while dia was closed follows the schedule's catch-up rule. (Test: a schedule fires, the plugin's scope closes ("dia closed"), the clock moves past two of its times, a new scope opens on the same database file. With `catchUp: 'once'` exactly one entry is enqueued at once and the next is at the first time after that fire; with `catchUp: 'skip'` nothing is enqueued until the first time after now.)

Supporting tests: `remove` while a fire waits for a `RunQueue` completes; an interval under one second fails decoding; a `Runs.start` defect fails the activity run with `ActivityRunFailed` whose `retryAt` is the next time after now; `put` of an unchanged definition keeps the schedule's anchor; `put` of a changed definition re-times it from now; `remove` stops it; an invalid cron expression or time zone fails `put` with `InvalidSchedule`; a fire while no `RunQueueKey` is provided waits and enqueues once one is; an `enqueue` interrupted because `dia-run-queue` stopped is retried on the next provider.

## How schedules relate to `ctx.activities`

Each stored schedule is registered as one background activity (`ctx.activities.register`, `src/shared/plugin/api.ts`), with the schedule's `id` as the activity id and its `label` as the activity label. The activity owns the timing: it sleeps until the due time (re-reading the clock at least every 5 minutes, `ACTIVITY_RECHECK` in `src/host/services/background-activities.ts`, so a system suspend delays a run by at most 5 minutes), shows the schedule on the Plugins page with its next time and last outcome, and offers "Run now". The activity's `run` enqueues the schedule's run on the run queue and returns the schedule's next time. `dia-schedules` owns what activities do not: the stored definition, the time a schedule last fired (activities keep no state across restarts) and the catch-up rule, which it applies when it computes an activity's `firstRunAt`.

## Decisions taken without the user

D1. **Each schedule is a `ctx.activities` activity** (above). Alternative: a timer fiber per schedule in the plugin (rejected: it duplicates the activity scheduler's suspend-safe sleep, and schedules would be absent from the Plugins page). Alternative: one activity that scans every schedule (rejected: the Plugins page would show one row for all schedules, and "Run now" could not pick one).

D2. **Two catch-up rules: `skip` (default) and `once`.** `skip` drops every time missed while dia was closed and waits for the next time; `once` starts one run at once for any number of missed times. paperclip's `catchUpPolicy` (`packages/db/src/schema/routines.ts`) defaults to `skip_missed` and offers `enqueue_missed_with_cap` (one run per missed time, at most 25, `server/src/services/routines.ts`); t3code's `ScheduledTaskService.rescheduleMissedRun` skips missed fixed-time runs. Alternative: one run per missed time (rejected: a run is an agent turn costing tokens; ten missed hourly runs doing the same job are one job).

D3. **A schedule's times.** `nextTime(times, after)`: for an interval schedule, `after` plus the interval; for a cron schedule, `Cron.next(cron, after)` (Effect v4 `Cron`, `node_modules/effect/src/Cron.ts:800`, which returns a `Date`, converted with `DateTime.fromDateUnsafe`; 5 or 6 fields, seconds first in 6). The cron is parsed with `Cron.parse(expression, timeZone)` (`Cron.ts:552`); a `CronParseError` (bad expression or time zone) becomes `InvalidSchedule`. `timeZone` is an IANA name; without one, `Cron.next` uses the system's UTC offset at each instant (`makeZonedUnsafe` with no `timeZone`, `internal/dateTime.ts:269`), so `0 9 * * *` means 09:00 local time. Tests set `timeZone` explicitly. A new schedule's anchor is the time it was stored. For an interval schedule, waiting for "the first time after now" restarts its cadence at now.

D4. **The stored anchor is `fired_at`, written once the queue returns the run's id.** The fire runs in `Effect.uninterruptibleMask`, with `enqueue` inside `restore` and the write after it outside (D5), so a returned run id is always recorded even when the scope closes during the start (the queue makes a picked `enqueue` wait for its start). A fire that has not started its run when dia closes (held by the queue's limit) counts as missed at the next start, and its catch-up rule applies. `fired_at` is the time the fire began. At registration and after each fire, the activity's next time is `nextRunAt(times, catchUp, fired_at, now)`: `nextTime(times, fired_at)` when that is after now or the rule is `once`, otherwise `nextTime(times, now)`. When times passed while a fire waited in the queue, `once` fires again at once (one run for all of them) and `skip` waits for the next time after now.

D5. **Activities register in the plugin's scope, not inside `whenProvided([RunQueueKey])`.** A fire waits until a `RunQueue` is provided, then calls `enqueue` under `Effect.exit`. When `dia-run-queue` stops, its finalizer interrupts every waiting `enqueue` (D5 of `dia-run-queue.md`); the fire sees a cause for which `Cause.hasInterruptsOnly` holds, waits until the ref holds a `RunQueue` other than the instance it used (the ref may still hold the stopped instance for a moment), and enqueues again. Every wait and every `enqueue` runs inside `restore`; only the `fired_at` write after a returned id is uninterruptible. When the schedule's own scope closes (a `remove`, a changed `put`, the plugin stopping), the fire's fiber is interrupted, `enqueue` withdraws the entry (or returns the id of a picked one, which is then written), and the next wait inside `restore` ends the fiber, so closing the scope never waits for a new `RunQueue`. The fire does not tell its own interruption from a queue stop (both are interrupt-only causes): on its own interruption the next wait inside `restore` fails at once; on a queue stop it blocks until a new `RunQueue`. Only the `enqueue` call is under `Effect.exit`; a wait's failure is never caught. Any other cause (a defect of `Runs.start`) becomes `ActivityRunFailed` with `retryAt` = `nextTime(times, now)` for both rules (never `began`, which can be in the past after a long queue wait) and `fired_at` unwritten; without the conversion the host treats it as a defect and retries after an hour (`ACTIVITY_DEFECT_RETRY`). Alternative: register inside `whenProvided` (rejected: every `dia-run-queue` reload removes and re-adds every schedule on the Plugins page and re-applies the catch-up rule, which for `skip` drops a time that passed during the reload).

D6. **Callers choose the id, and `put` is an upsert that keeps an unchanged definition as it is.** A caller such as the org rewrite re-derives its schedules from its own state at each start and calls `put` for each; an unchanged definition keeps its `fired_at` and its activity, so a restart neither resets an interval nor loses a missed time. A changed definition is re-anchored at now. "Unchanged" means an equal JSON encoding; key order inside `context` is the caller's to keep stable. `put` and `remove` hold one plugin-wide `Semaphore(1)`, because served calls can overlap and resend (`HostPluginContext.serve`) and a second registration of an id is a defect (`background-activities.ts:93`). The id is an `ActivityId` (`^[a-z][a-z0-9-]*$`), because it is the activity id; callers prefix it with their plugin name by convention. Alternative: `create` returns a generated id (rejected: a caller that restarts mid-create cannot tell whether its schedule exists without a `list` and a stored mapping).

D7. **No renderer surface; two plugin calls.** No screen in this step's scope creates schedules. `dia-schedules` serves `PutSchedule` and `RemoveSchedule` (`ctx.serve`), the only way to create a schedule in the running app (the in-app proof calls them with `window.dia.plugins.call`, as the `dia-run-queue` proof called `StartRun`); the Plugins page already shows schedules as activities. No `list` is offered: no caller needs it in this step.

D8. **Schedules start runs with no tab**, with the `run` options stored in the definition, through `RunQueue.enqueue` with the definition's optional `priority` and `key`. A run's `labels` and `context` pass through unchanged.

## Interface

### Exported module (`plugins/dia-schedules/schedules.ts`, imported as `@dia-plugin/dia-schedules/schedules`)

```ts
/** Repeats every `interval` (at least one second) after the schedule last fired; after times missed under `skip`, it repeats from now. */
export const Interval = Schema.TaggedStruct('Interval', {
  interval: /* a finite number of milliseconds of at least 1000, decoded to a Duration as DurationFromMillis does (Schema.ts:13876) */
})
/** Fires at the times of cron `expression` in IANA `timeZone` (default: the system's). */
export const CronTimes = Schema.TaggedStruct('CronTimes', {
  expression: Schema.String,
  timeZone: Schema.optional(Schema.String)
})
/** When a schedule fires. */
export const ScheduleTimes = Schema.Union([Interval, CronTimes])
/** What happens to times missed while dia was closed (D2). */
export const CatchUp = Schema.Literals(['skip', 'once'])

/** The `StartRunOptions` a schedule's run starts with; its type is checked assignable to `StartRunOptions`. */
export const ScheduledRun = Schema.Struct({
  cwd: Schema.String,
  model: Schema.String,
  thinkingLevel: ThinkingLevel,
  permissionMode: PermissionMode,
  text: Schema.String,
  labels: Schema.optional(Schema.Array(Schema.String)),
  context: Schema.optional(Schema.Json)
})

/** A schedule: what run to start, when, and what to do about missed times. */
export const Schedule = Schema.Struct({
  id: ActivityId,
  label: Schema.String,
  times: ScheduleTimes,
  catchUp: CatchUp,
  run: ScheduledRun,
  priority: Schema.optional(Schema.Number),
  key: Schema.optional(Schema.Struct({ id: Schema.String, limit: Schema.Int /* at least 1 */ }))
})
export type Schedule = typeof Schedule.Type

/** `put` refused a schedule: an invalid cron expression or time zone. */
export class InvalidSchedule extends Schema.TaggedError<InvalidSchedule>()('InvalidSchedule', {
  id: Schema.String,
  message: Schema.String
}) {}

/** Stores and times schedules; read it with `ctx.whenProvided([SchedulesKey], …)`. */
export interface Schedules {
  /** Stores `schedule` under its id and times it; an unchanged definition is left as it is (D6). */
  readonly put: (schedule: Schedule) => Effect.Effect<void, InvalidSchedule>
  /** Removes schedule `id`; an absent id does nothing. Completes once no run of this schedule can start any more: a fire waiting in the queue is withdrawn, and a start already in progress has finished. */
  readonly remove: (id: string) => Effect.Effect<void>
}

/** The key `dia-schedules` provides {@link Schedules} under: `schedules`. A value counts when `put` and `remove` are functions (module-private `isSchedules`). */
export const SchedulesKey = ServiceKey.make('schedules', isSchedules)

/** Calls `Schedules.put`; fails with {@link InvalidSchedule}. */
export const PutSchedule = Rpc.make('PutSchedule', { payload: { schedule: Schedule }, error: InvalidSchedule })
/** Calls `Schedules.remove`. */
export const RemoveSchedule = Rpc.make('RemoveSchedule', { payload: { scheduleId: Schema.String } })
```

These are plugin calls (`ctx.serve`, `src/shared/plugin/messages.ts`), not members of `DiaRpcs`, so `PROTOCOL_VERSION` does not change.

`ActivityId` is added to the exports of `src/host/plugin-api.ts`. `PLUGIN_API_VERSION` does not change: its rule (`src/shared/plugin/manifest.ts:19`) is to bump on a change to the plugin context, and a new value export of `@dia/plugin` is not one.

### Plugin internals

- `plugin.json`: `name: dia-schedules`, `category: feature`, `host: host.ts`, `load: eager`, `exports: ["schedules.ts"]`.
- `times.ts` (pure): `parseTimes(schedule)` returns the parsed times or `InvalidSchedule`; `nextTime(times, after)` (D3); `nextRunAt(times, catchUp, firedAt, now)` (D4).
- `migrations.ts`: `1_create_schedules`: `schedules(id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, fired_at INTEGER NOT NULL)`.
- `make-schedules.ts`: `makeSchedules({ activities, sql, queue: SubscriptionRef<Option<RunQueue>> })`, scoped. Loads every row and registers each as an activity in its own child scope of the plugin's scope (a `Map<id, Scope.Closeable>`), and returns `Schedules`. `put` (under the semaphore) parses the times, compares the stored `definition_json`, and on an unchanged definition does nothing; otherwise it closes the old child scope (awaiting a start in progress), writes the row with `fired_at` now, and registers the new activity. `remove` (under the semaphore) closes the child scope, then deletes the row. An activity run does what D4 and D5 state; `fired_at` is written with `UPDATE … WHERE id = ?`, never an upsert, so a late fire cannot revive a removed row. A row whose JSON no longer decodes is logged as a warning and skipped. Database errors die (local SQLite).
- `host.ts`: follows `RunQueueKey` with `ctx.whenProvided` into a `SubscriptionRef<Option<RunQueue>>` (the `dia-run-queue` precedent for `RunsKey`), setting it only after `ctx.pluginsSettled`, so a catch-up fire at launch starts its run after every eager plugin (for example `dia-tools`, whose tools the run gets) has loaded, opens `ctx.database(schedulesMigrations)`, builds `makeSchedules`, provides `SchedulesKey`, and serves `PutSchedule` and `RemoveSchedule`.
- Logging: register, put (changed or unchanged), remove and each fire (with the run id and next time) at info; a skipped catch-up at info; an undecodable row at warning.

## Refinement Record

Round 1 (subagent, sonnet):

**Applied**
- *Correctness, blocker* — `Cron.next` returns a `Date` and the time zone is an argument of `Cron.parse`; D3 states both and cites the default-zone behaviour (`internal/dateTime.ts:269`, verified).
- *Correctness, blocker* — after the queue's finalizer interrupts `enqueue`, the ref can still hold the stopped queue; the retry now waits for a different instance (D5), using `Cause.hasInterruptsOnly` (`Cause.ts:648`).
- *Correctness, major* — a scope closing between `enqueue` returning and the `fired_at` write would lose the anchor and duplicate a `once` run; both now run under `uninterruptibleMask` (D4).
- *Correctness, major* — concurrent or resent `put`s could register an id twice (a defect), and a late fire could overwrite or revive a row; `put`/`remove` hold a semaphore, unchanged definitions are a no-op, the old scope closes before the write, and `fired_at` is written with `UPDATE`.
- *Correctness, major* — `enqueue` is `Effect<string>`, so a defect would reach the host as a defect (1-hour retry); the fire converts a non-interrupt cause to `ActivityRunFailed` (D5).
- *Define errors out of existence, major* — a zero or negative interval and a non-JSON `context` were representable; the interval is checked greater than zero, `key.limit` an int of at least 1, `context` is `Schema.Json` (`Schema.ts:17804`).
- *Project rules, major* — one JSDoc per export, including `ScheduleTimes` and `Schedules`.
- *Minor* — interval cadence restart under `skip` stated; D4 aligned with the internals; `isSchedules` described; leftover `schedule-store.ts` line removed; `ScheduledRun` checked against `StartRunOptions`; supporting test for the defect path added.

**Rejected**
- *AHA, minor, drop `PutSchedule`/`RemoveSchedule`* — they are the only way to create a schedule in the running app, which the in-app proof needs (D7).
- *Project rules, minor, bump `PLUGIN_API_VERSION`* — the rule in `manifest.ts:19` bumps on a plugin-context change; a new `@dia/plugin` export is not one.
- *Minor, tests for concurrent `put` and for `remove` during a fire* — the semaphore and scope close are exercised by the unchanged/changed `put` and `remove` tests; a race test needs timing hooks the code does not otherwise need.

Round 2 (subagent, sonnet):

**Applied**
- *Correctness, blocker* — with the retry wait outside `restore`, closing a schedule's scope while no `RunQueue` existed would hang `remove` with the semaphore held. Every wait and `enqueue` now runs inside `restore`; only the `fired_at` write is protected (D5). Supporting test added.
- *Correctness, major* — Schema has no Duration filter and `DurationFromMillis` admits `Infinity`; the interval is now a finite number of milliseconds of at least 1000 decoded to a `Duration`. Supporting test added.
- *Project rules, minor* — `remove`'s JSDoc states the outcome rather than the mechanism; the calls are stated to be plugin calls outside `DiaRpcs` (`PROTOCOL_VERSION` unchanged); `RemoveSchedule`'s payload field is `scheduleId`.
- *Minor* — the `skip` cadence restart moved into the `Interval` JSDoc.

**Rejected**
- *Correctness, major, compare definitions by deep equality instead of JSON encoding* — `JSON.stringify` follows insertion order, which is fixed for a given caller's code; a caller whose code changes the order re-anchors once, the same outcome as changing the definition. A canonical-JSON helper is code no current caller needs.
- *Minor, a test for a restart after a failed fire* — a failed fire leaves `fired_at` as an unfired schedule's, the path criterion 2's test covers.
- *Minor, a minimum spacing for a cron with a seconds field* — a cron expression states its times explicitly; each fire waits for its run to start, so fires do not pile up.

Round 3 (subagent, sonnet): `restore` semantics verified (`internal/effect.ts:4614-4630`).

**Applied**
- *Correctness, major* — `retryAt` after a defect could be in the past under `once`, re-firing a persistent defect with no delay; it is now `nextTime(times, now)` for both rules.
- *Correctness, minor* — D5 states that only `enqueue` is under `Effect.exit` and that own interruption and a queue stop are not told apart.

Rounds stop: no blocker or major finding remains.

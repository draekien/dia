# Objectives page and streaming plugin calls (#180)

Scope: module. Two parts:

1. **Kernel:** a plugin's host entry can serve a *streaming* call with `ctx.serve`. Its renderer entry follows it with `followHost`. This amends ADR-0057, whose call table says "a struct `payload`, never a stream". The amendment is recorded in a new ADR, ADR-0068.
2. **`plugins/org`:** an Objectives page with an objective form, and an objective screen that adds, assigns and finishes tasks. The screen follows changes through a `WatchWork` stream.

Out of scope:
* Editing or deleting an objective.
* Planning tasks, and starting an objective's assignee (#181).
* Decision path review.
* The Dashboard's Running now and Waiting tasks items.
* Answering held permissions (#182).
* Typed plugin events.
* Creating a sub-task from the screen. Agents create sub-tasks in #181; the screen shows them.

Decisions taken with the user in Understand (2026-11-08):

| Decision | Choice |
| --- | --- |
| Task actions on the objective screen | Add task, an assignee per task, Finish on a running task |
| How the screen sees changes the dispatcher makes | A push channel from the host entry to the renderer entry |
| Shape of the push channel | A streaming plugin call (`ctx.serve` of a stream rpc) |
| PR split | One PR for #180 |
| An objective created with an assignee | Stores the assignee only, creates no task |

## Kernel: streaming plugin calls

### Declaring and serving

A plugin declares a streaming call with `Rpc.make(tag, { payload, success, error, stream: true })`, in a module both entries import. The host entry serves it with `ctx.serve`:

```ts
ctx.serve(WatchWork, () => workViews)   // handler: (payload) => Stream<Success, Error>
```

`serve` (`src/shared/plugin/api.ts`) becomes an overloaded function type:

* The existing request/response signature.
* A signature whose `rpc` has a stream success schema, and whose handler returns `Stream.Stream<Rpc.SuccessChunk<R>, Rpc.ErrorExit<R>>` (`effect/rpc`, `Rpc.ts:366`). For a stream rpc `Rpc.Error<R>` is `never`, because the error schema sits inside the stream schema.

The `serve` JSDoc (`api.ts:205`) and the `servePluginCall` JSDoc both say a streaming `rpc` is a defect; that sentence is removed from both.

`servePluginCall` (`src/host/plugins/plugin-messages.ts`) no longer dies on a stream rpc. For one, it:

* takes the value and error schemas from `RpcSchema.isStreamSchema(rpc.successSchema)` (its `.success` and `.error`). `RpcSchema.getStreamSchemas` is `@internal` and missing from the published types;
* encodes each value and each error with `jsonCodec` of those schemas;
* provides a `PluginStreamHandler` under the same `call:<plugin>.<tag>` key, branded with its own private symbol.

`callPlugin` on a stream tag, and `subscribePlugin` on a request/response tag, fail with `PluginCallInvalid` and the message ``"`<tag>` is a streaming call"`` or ``"`<tag>` is not a streaming call"``.

### Lifetime: a subscription holds no lease

A subscription does **not** hold a `registry.use` lease while it runs. Closing a plugin waits up to `SERVICE_USE_TIME_LIMIT` (30 s) for its active leases (`plugin-registry.ts:578-600`), so an open page that held one would delay every reload and unload by 30 s.

How a subscription ends instead:

1. `servePluginCall` creates a `Deferred<void>` named `closed` inside its own `Effect.gen`, once per served stream tag per plugin open, and adds `Effect.addFinalizer(() => Deferred.succeed(closed, undefined))` to the scope it runs in. Each open serves again with a fresh `closed`.
2. `subscribePlugin(registry, request)` leases the handler with `registry.use` only to build the stream value; `use` releases the lease when `f` returns (`plugin-registry.ts:617-680`). With no handler, or while the plugin is closing, `use` returns `None`, which becomes `PluginNotServing` (as `callPlugin` does, `plugin-messages.ts:98-101`).
3. The stream given to the subscriber is:

   ```ts
   handlerStream.pipe(
     Stream.interruptWhen(Deferred.await(closed)),       // ends the stream, interrupting a pull in progress (Stream.ts:17390-17412)
     Stream.concat(Stream.unwrap(Effect.map(Deferred.isDone(closed),
       (done) => (done ? Stream.fail(notServing) : Stream.empty)))),
     Stream.ensuring(release)                            // counts the subscription as ended
   )
   ```

   A handler stream that completes on its own, while `closed` is pending, completes the subscription (`Done`). One ended by `closed` fails with `PluginNotServing`.
4. A private `SubscriptionTracker` holds `closed`, a count of running subscriptions and a `drained` Deferred. `servePluginCall` creates one per served stream tag per open. It exposes:
   * `guard(stream)`: wraps the subscriber's stream in `Stream.unwrap(Effect.suspend(...))`. When the stream starts, it checks `Deferred.isDoneUnsafe(closed)` and raises the count in one synchronous block. If `closed` is done, it fails `PluginNotServing` and never runs the handler stream. `Stream.ensuring(release)` lowers the count, and `release` completes `drained` when the count reaches 0 after `closed` is done. A stream that never started was never counted.
   * `close`: the serve finalizer. It completes `closed`, then waits for `drained` (at once when the count is 0) with `Effect.timeoutOption(SERVICE_USE_TIME_LIMIT)`. On a timeout it logs a warning with the plugin, the tag and the remaining count, and returns, as `drainLeases` does (`plugin-registry.ts:586-599`). The finalizer runs inside `closePlugin`'s `uninterruptibleMask` (`plugin-registry.ts:608`), so the timeout is what bounds it.

`closePlugin` runs `drainLeases`, then `Scope.close` (`plugin-registry.ts:602-614`). Finalizers run in reverse order of acquisition. The serve finalizer returns after every subscription of that tag has ended, or after the time limit, so a subscription does not start or keep running handler code once resources acquired earlier in setup, such as `ctx.database`, begin to close.

**Rule for a stream handler:** it may use only resources of the scope that serves it, or of an enclosing scope. A service held in a `ctx.whenProvided` or `ctx.inject` scope closes first (`plugin-registry.ts:697-714`), so a stream handler must not read one. The org host entry serves `WatchWork` in its setup scope (`host.ts:185`), where `work` and `dispatcher` were built. It never reads the agent backend that `whenProvided` holds (`host.ts:45`).

```
renderer page        preload               Host rpc-handlers       org host entry
followHost ──▶ plugins.subscribe ──▶ SubscribePlugin ──▶ use(call:org.WatchWork) → Stream
   ◀── Some(view) ◀── onValue ◀──────────── frame ◀───────────── workViews
org reloads: closed completes → PluginNotServing → followHost emits None, waits, subscribes again
```

### RPC, preload and renderer

* **`src/shared/plugin/messages.ts`:** add `PluginSubscriptionFailure { error: PluginCallError }` and `PluginSubscriptionDone {}` as named `TaggedStruct`s, each with a JSDoc, and `PluginSubscriptionEnd = Schema.Union([...])` with `export type PluginSubscriptionEnd = typeof PluginSubscriptionEnd.Type`. Values are built with `.make`.
* **`src/shared/ipc/rpc.ts`:**
  * Add `SubscribePlugin`: `{ payload: { plugin, tag, payload: Unknown }, success: Unknown, error: PluginCallError, stream: true }`.
  * Document it in the `DiaRpcs` JSDoc: it is not a query, the preload subscribes again after a lost connection, and its handler may run more than once.
  * Bump `PROTOCOL_VERSION` from `0.0.25` to `0.0.26`.
* **Host `rpc-handlers.ts`:** serve `SubscribePlugin` from `subscribePlugin(registry, request)`.
* **Preload `window.dia.plugins.subscribe(plugin, tag, payload, onValue, onEnd): () => void`:**
  * `onValue` receives each encoded value.
  * `onEnd` receives the encoded form of a `PluginSubscriptionEnd` (`PluginSubscriptionEndJson`, because class instances do not cross `contextBridge`): `Failure` when the stream fails with a `PluginCallError`, `Done` when it completes. `followHost` decodes it.
  * Any other failure (a lost connection) subscribes again after `RESUBSCRIBE_INTERVAL` with no limit, and warns through `deps.warn`, as `SubscribeEvents` does (`host-api.ts:194-202`). A subscription emits its current state first, so subscribing again loses nothing.
  * The returned function interrupts the subscription.
* **Renderer `followHost(ctx, rpc, payload)`** (`src/renderer/src/lib/plugin-messages.ts`, exported from `@dia/renderer-plugin`):
  * Returns `Stream.Stream<Option<Rpc.SuccessChunk<R>>, Rpc.ErrorExit<R> | PluginCallInvalid>`.
  * It encodes `payload` the way `callHost` does (`rpc.payloadSchema.make`, `plugin-messages.ts:31-33`) before subscribing, so an encode error is `PluginCallInvalid` on the stream.
  * It subscribes through a private `subscribeHost` built with `Stream.callback` over `window.dia.plugins.subscribe`, and decodes each value as `Some`.
  * On `PluginNotServing` it emits `None` (once: a failed retry emits no second `None` until a value arrives), and waits for the next `PluginStatusChanged` with `name === ctx.name` (the event carries only the name, `contract.ts:599-608`), or for `PLUGIN_RETRY_INTERVAL = Duration.seconds(5)`, whichever is first. The wait is `Effect.race` of the event and `Effect.sleep(PLUGIN_RETRY_INTERVAL)`, so `TestClock` drives it in tests. Then it subscribes again. A failed attempt loops back to the wait. The timed retry covers a status event lost during a reconnect, which is never replayed.
  * Interrupting the stream calls the function `subscribe` returned.
  * `None` means the plugin's host entry is not serving. `AsyncResult.Initial` means the first subscription has not answered yet.
* **`PLUGIN_API_VERSION`** goes from `0.0.31` to `0.0.32`, because `serve` and `followHost` change the plugin API. Every `plugins/*/plugin.json` declares the new version.

## `plugins/org`: the work feed

### `WatchWork` (calls.ts)

```ts
/** The WorkView now, then again after every change to objectives, tasks, held slots or pending permissions. */
export const WatchWork = Rpc.make('WatchWork', { payload: {}, success: WorkView, stream: true })
```

`ReadWork` stays, for tests and later callers.

### Change signal

`work.ts` owns a `PubSub.unbounded<void>()`. It publishes after each committed transaction of `createObjective`, `createTask`, `assignTask` and `finishTask`, and after each `TaskRuns` write that changed a row.

`dispatcher.ts` owns another. Today six sites modify the live map `tasks` (`dispatcher.ts`: `onEvent`, `startTask`, `drop`, `answerPermission`, `resumeTask`, the pass reservation). They are routed through one private `updateTasks(f)` helper. `f: (current) => readonly [A, Map | undefined]` returns `undefined` when it changes nothing, and `updateTasks` publishes only when `f` returns a map. The pass returns `undefined` when `chosen.start` is empty, `drop` when the task is absent, and `onEvent` when `applyEvent` leaves the task unchanged (today it returns `current` there, `dispatcher.ts:183,186`). So a text delta during a running turn publishes nothing. `heldSlots` and `pendingPermissions` are derived from the map by `live`, so every change to either one publishes.

Each module exposes `watchChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>`. It subscribes to the PubSub **when run**, and the returned stream emits once per change after that.

`host.ts` serves:

```ts
ctx.serve(WatchWork, () =>
  Stream.unwrap(Effect.gen(function* () {
    const works = yield* work.watchChanges
    const lives = yield* dispatcher.watchChanges
    return Stream.concat(
      Stream.make(undefined),
      Stream.merge(works, lives).pipe(Stream.buffer({ capacity: 1, strategy: 'sliding' }))
    ).pipe(Stream.mapEffect(() => readWorkView))   // work.snapshot + dispatcher.live
  })))
```

Both subscriptions exist before the first read, so a change committed during that read still gives another read. With the sliding buffer of 1 before `mapEffect`, any number of changes during one read give exactly one more read.

## `plugins/org`: renderer

### Navigation

`org-view.ts` adds `ObjectivesView { objectiveId: NullOr(ObjectiveId) }` to `OrgView`, built with `ObjectivesView.make`. `showView` is unchanged.

`ObjectivesPage` resolves `objectiveId` against the current `WorkView` itself:
* An id the view holds shows that objective.
* An id the view does not hold shows the detail skeleton until a push holds it. A created objective can arrive in a later push than the `CreateObjective` reply. Objectives are never deleted in this PR, so the id always arrives.
* Null shows the first objective in list order (priority, then newest).

The page never rewrites `view`. `org-page.tsx` `NAV` puts `Objectives` in the Overview group, between Dashboard and Org chart.

### Work state

`renderer.ts` creates `workAtom = Atom.make(followHost(ctx, WatchWork, {}))` once, next to `orgAtom` (`renderer.ts:16`), and passes it to `OrgPage` as a prop (`Atom.make` accepts a Stream, `effect/src/reactivity/Atom.ts:499-516`). `org-actions.ts` exports the `WorkAtom` type with a JSDoc, as it does `OrgAtom`.

The atom's value is `AsyncResult<Option<WorkView>>`. It is not `keepAlive`, so it unsubscribes when no page reads it, and subscribes again, receiving the current state first, each time the Objectives page mounts. The Objectives page reads `orgAtom` (hired agents and job titles) and `workAtom`.

### Objectives page (`objectives-page.tsx`)

A list and detail page with the same structure as `job-titles-page.tsx` (`EntryList` beside the detail):

* List entries: the objective title, and its project name from `useWorkspace()`, ordered by priority (high first) then newest first. Completed objectives come last, muted.
* Heading action: `New objective…` opens `ObjectiveDialog`.
* Empty: `Empty` with `No objectives yet` and the `New objective…` button.
* `workAtom` is `Some(None)`: `The org plugin's host entry is not loaded.`

### Objective form (`objective-dialog.tsx`)

A `Dialog` with one `Field` per row, in the `org-fields.tsx` style:

| Field | Control | Rule |
| --- | --- | --- |
| Project | `Select` of `useWorkspace().projects` by `displayName` | Required. With no projects, the dialog shows `Add a project first` and no Create button |
| Title | `Input` | 1 to 120 characters after trimming (`WorkTitle`) |
| Description | `Textarea` | May be empty |
| Priority | `ToggleGroup` High, Normal, Low | Default Normal |
| Assignee | `Select`: `None (planning task)` and each hired agent by name and job title | Default None |

Create sends `CreateObjective` with a new `ObjectiveId` from `crypto.randomUUID()`. On success the dialog closes and the new objective is selected. A typed error (`ProjectNotFound`, `HireNotFound`) shows under the form, and the dialog stays open.

### Objective screen (`objective-screen.tsx`)

* **Header:** the title. Under it, the project name, priority, state (`Open` or `Completed`), assignee (`Unassigned` when null), and the description (`No description` when empty).
* **Tasks:** a tree of the tasks whose `objectiveId` is the objective's. Roots have `parentTaskId` null. A retro task's parent is the task it reviews, so it shows under that task. Children are ordered by `createdAt`.
* **Task row:**
  * title;
  * a `Retro` badge when `kind === 'retro'`;
  * the state (`Waiting`, `Running`, `Finished`, `Completed`) with `taskStateVariants = cva(...)`, exported from `objective-screen.tsx` with a JSDoc;
  * an assignee `Select` (`Unassigned` and each hired agent), enabled only while the state is `waiting` (`assignTask` fails with `TaskNotWaiting` otherwise, `work.ts`). Changing it sends `AssignTask`;
  * a `Finish` button, shown only while the state is `running` (`finishTask` fails with `TaskNotRunning` on a waiting task). It sends `FinishTask`.
* **Add task:** an inline form under the tree, with a title `Input` (1 to 120 characters), an assignee `Select` (default Unassigned) and an `Add task` button. It sends `CreateTask` with a new `TaskId` and `parentTaskId: null`. It is hidden on a completed objective.
* A call's typed error shows through the existing `useOrgCall` failure path.

UI components come from `@dia/renderer-plugin`, as in `job-titles-page.tsx` and `org-fields.tsx`. `Select`, `ToggleGroup`, `Empty`, `Dialog`, `Input` and `Textarea` are all exported there (`src/renderer/src/plugin-api.ts`).

### Design

Each screen is designed with `/impeccable` against fixture data, and passes its finish review against `DESIGN.md` before it is wired to real data. The fixture data is in `org-host.fake.tsx`, extended with objectives, tasks and a fake `plugins.subscribe`.

## Conventions

* Every new export has a JSDoc giving its inputs, outputs and when to call it: `subscribePlugin`, `followHost`, `PluginSubscriptionEnd` and its members, `WatchWork`, `ObjectivesView`, `workAtom`, `ObjectivesPage`, `ObjectiveDialog`, `ObjectiveScreen`, `taskStateVariants`, `watchChanges`, `WorkAtom`. `PLUGIN_RETRY_INTERVAL` and `PluginStreamHandler` are module-private.
* These log with `Effect.logDebug` or `Effect.logInfo` (plugin, tag, reason): `subscribePlugin`, the serve finalizer, the preload's resubscription (`deps.warn`), and each `followHost` change between serving and not serving.

## Tests

| Criterion | Test |
| --- | --- |
| 1 Stream served, values received, unload ends with `PluginNotServing`, resubscribe after reload | Host `plugin-messages.test.ts`: <br>• a stream rpc delivers 2 values <br>• unload ends it with `PluginNotServing`, without waiting 30 s <br>• subscribing while the plugin is closing gets `PluginNotServing` <br>• after a reload a new subscriber receives values <br>• an in-flight effect is interrupted at close <br>• `callPlugin` on a stream tag fails with `PluginCallInvalid`. <br>`rpc-handlers.test.ts`: a `SubscribePlugin` with `payload: { payload: 1 }` gives the handler `{ payload: 1 }` unchanged. <br>`host-api.test.ts`: `plugins.subscribe` values, `onEnd`, resubscription after a lost connection. <br>Renderer `plugin-messages.test.ts`: `followHost` decodes values, emits `None` on `PluginNotServing`, and subscribes again after a `PluginStatusChanged` for its plugin |
| 2 List and select | `org-page.test.tsx` |
| 3 Form | `org-page.test.tsx`: sends `CreateObjective`, rejects an empty and a 121-character title, lists only workspace projects |
| 4 Task actions | `org-page.test.tsx`: Add task, an assignee change, Finish; the assignee select is disabled on a running task |
| 5 Live state | `dispatcher.test.ts`: `watchChanges` emits on a reservation, a pending permission, an answer and a drop. It does not emit on a text delta during a running turn, on a pass that starts nothing, or on dropping an absent task. Host `plugin-messages.test.ts`: <br>• the serve finalizer returns only after a subscription blocked in an effect has ended <br>• a stream started after `closed` gets `PluginNotServing`, and its handler never runs <br>• a subscription stuck in an uninterruptible effect stalls close for at most `SERVICE_USE_TIME_LIMIT` (`TestClock`). `host.test.ts`: `WatchWork` emits again after `CreateTask`, and after the dispatcher starts the task. `org-page.test.tsx`: a pushed WorkView updates the open screen |
| 6 Tree | `org-page.test.tsx`: a sub-task and a retro under their parent |

## ADR

ADR-0068, *Plugin host entries serve streaming calls, and a subscription holds no lease*, amends ADR-0057 and is added to the index.

## Refinement Record

### Round 1

| # | Tag | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | blocker | `PluginStatusChanged` carries only `name` and is never replayed, so the renderer cannot wait for "Loaded" | Applied: wait for any status event for the plugin, or 5 s, then retry |
| 2 | blocker | An ended stream stops only at its next pull; an in-flight read could outlive the database | Applied: `Stream.interruptWhen(Deferred.await(closed))` |
| 3 | blocker | A stream rpc's `successSchema` is a `RpcSchema.Stream` wrapper | Applied: `RpcSchema.getStreamSchemas`; both JSDocs updated |
| 4 | major | `resendSchedule` stops after 30 s, and a transport failure had no `onEnd` mapping | Applied: unbounded resubscribe at `RESUBSCRIBE_INTERVAL` |
| 5 | major | `prepend` takes an Iterable, and the lazy PubSub subscription loses a change during the first read | Applied: `watchChanges` subscribes when run, before the first read |
| 6 | major | A lease-less stream is safe only under a stated condition | Applied: the stream handler rule, checked against `host.ts:45` and `host.ts:185` |
| 7 | major | Where `closed` lives was not stated | Applied: one per tag per open; tests for closing and reload |
| 8 | major | Missing wrapper-field test and `DiaRpcs` JSDoc | Applied |
| 9 | major | Conventions for tagged values, JSDoc and logging | Applied: `PluginSubscriptionEnd` schemas and a Conventions section |
| 10 | major | Component availability and `cva` location | Applied: verified in `plugin-api.ts` exports; `taskStateVariants` in `objective-screen.tsx` |
| 11 | minor | Wording; `subscribeHost` and `followHost` both exported with only one caller | Applied: only `followHost` exported; `subscribeHost` private |

### Round 2

| # | Tag | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | major | `showView` cannot take a `WorkView` (a separate atom); select-after-create races the push | Applied: `showView` unchanged; `ObjectivesPage` resolves the id and shows a skeleton for an id not yet pushed |
| 2 | major | `workAtom(ctx)` as a function makes a new atom per call | Applied: created once in `renderer.ts`, passed as a prop |
| 3 | major | The dispatcher has no single point where the live state changes | Applied: one `updateTasks` helper publishes on a new map |
| 4 | major | The serve finalizer did not wait for interrupted subscriptions to end | Applied: subscriptions counted; the finalizer waits for 0 |
| 5 | minor | An unconditional `PluginNotServing` made `Done` unreachable | Applied: fail only when `closed` is done |
| 6 | minor | 5 s was a raw literal | Applied: `PLUGIN_RETRY_INTERVAL` `Duration`, `TestClock` |
| 7 | minor | Missing derived type and JSDocs | Applied |
| 8 | minor | `Option<WorkView>` puts a not-serving state in every consumer | Rejected: "not serving" is a state the page displays, not an error, and a `Failure(PluginNotServing)` would show the error path for a normal reload |

### Round 3

| # | Tag | Finding | Outcome |
| --- | --- | --- | --- |
| 1 | blocker | Where the count is raised was unstated: a stream built but never started leaked a count, and a stream started after the finalizer returned ran against a closing database | Applied: `SubscriptionTracker.guard` checks `closed` and raises the count when the stream starts; a late start is refused |
| 2 | major | The finalizer's wait was unbounded inside `closePlugin`'s `uninterruptibleMask` | Applied: bounded by `SERVICE_USE_TIME_LIMIT`, with a warning |
| 3 | major | The pass and `drop` build a new map on no-ops, so a reference check would publish on every pass | Applied: `f` returns `undefined` for no change |
| 4 | major | The "next push still lacks it" fallback races the reply, and is unreachable while objectives cannot be deleted | Applied: the skeleton shows until a push holds the id |
| 5 | minor | `closed`, the count and `drained` had no owner | Applied: private `SubscriptionTracker` |
| 6 | minor | The `onEvent` publish could happen on every streamed event | Applied: verified that `onEvent` returns `current` when nothing changes (`dispatcher.ts:183,186`); a test pins it |

Implementation changes (2026-11-08): the stream schemas come from `isStreamSchema`; the handler error is `Rpc.ErrorExit<R>`; `onEnd` takes the encoded end; `followHost` emits one `None` per outage; the serve finalizer's bounded wait is wrapped in `Effect.interruptible`, because it runs inside `closePlugin`'s `uninterruptibleMask`.

Rounds ended: the budget of 3 rounds (effort medium) is spent. No finding is escalated.

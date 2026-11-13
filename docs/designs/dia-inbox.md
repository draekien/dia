# `dia-inbox` plugin

Issue: draekien/dia#243, step 5 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0074, ADR-0076 (replaces the `decision-queue` plugin of ADR-0034).

`dia-inbox` lists every open permission request, clarifying question and plan review of every run, with or without a tab, on one page, and answers each through `dia-runs`. Before this step a request reached only the pane of the run that raised it, so a run with no tab could not be answered.

## Success criteria

1. A permission request from a run with no tab appears in the inbox, and the answer resumes the run. (Test: `plugins/dia-inbox/host.test.ts`, a `FollowInbox` subscriber over a `Runs` whose `requests` holds a permission request of a run with no tab receives an item with the run's `cwd`; `plugins/dia-runs/run-registry.test.ts`, a run started with `Runs.start` lists its permission request in `Runs.requests`, and `Runs.answer` passes the answer to the session and sets the run's status to `running`. App: `StartRun` from DevTools with a prompt that needs a tool permission, then Allow on the Inbox page; the run continues.)
2. The same request answered in a tab disappears from the inbox. (Test: `host.test.ts`, when `Runs.requests` drops the request, `FollowInbox` emits a list without it. App: answer in the tab, the Inbox page shows no item.)

## Decisions taken without the user

D1. **Answers go to `dia-runs`' existing calls.** The inbox renderer calls `callHost('dia-runs', ResolvePermission | ResolveQuestion | ResolvePlanReview, …)`, the calls a tab uses, so an answer from the inbox and one from a tab share `dia-runs`' call-id deduplication (dia-runs D6). Alternative: an `AnswerRequest` call served by `dia-inbox` that calls `Runs.answer`; it repeats `dia-runs`' handlers without deduplication.

D2. **The inbox draws a request with the chat plugin's request cards.** `dia-chat` provides one component under `RequestCardKey` (declared in its exported `slots.ts`) that draws any `UserInputRequest` with the card the pane uses and reports a `RunAnswer`. An exported module may not import React values (`docs/designs/plugin-module-exports.md`, part 2), so the component is provided as a service, as `dia-mcp` provides `McpServerPickerKey`. Alternative: cards written again in `dia-inbox`; two copies of the permission editor and question stepper.

D3. **The inbox is a page in `PagesSlot`**, labelled "Inbox". Alternative: a sidebar list or a count badge; `Page` has no badge field, and adding one changes `dia-layout` for no criterion here.

D4. **The inbox lists open requests only.** dia-runs D10 assigned "listing runs with no tab" to this step; each item has a Show action that opens its run in a tab, and a run with no open request is not listed. Alternative: a second section listing every run with no tab; no criterion asks for it, and it fits the queue step (step 7), which owns run listing by state.

D5. **Requests are not stored by the inbox.** A request is a callback of a live session (dia-runs D7); the inbox reads `Runs.requests` and holds nothing.

D6. **Show selects the run's tab, and asks `dia-runs` for a tab first when the run has none** (`OpenRunInTab`, then `actions.selectTab(runId)`, which also closes the Inbox page). The run id is the tab's pane id (dia-runs D2).

## Interface

### Exported calls (`plugins/dia-inbox/calls.ts`)

```ts
/** One open request of run `runId`, which works in `cwd`. */
export const InboxItem = Schema.Struct({ runId: Schema.String, cwd: Schema.String, request: Attention.UserInputRequest })
export type InboxItem = typeof InboxItem.Type

/** Every open request of every run, now and after each change; empty while no plugin provides runs. */
export const FollowInbox = Rpc.make('FollowInbox', { payload: {}, success: Schema.Array(InboxItem), stream: true })
```

### Host (`plugins/dia-inbox/host.ts`)

Follows `RunsKey` with `ctx.whenProvided` into a `SubscriptionRef<Option<Runs>>` and serves `FollowInbox`: an empty list while runs are not provided, otherwise each `Runs.requests` emission joined with `Runs.list` for each run's `cwd`. A request whose run has no row is listed with an empty `cwd`.

### Chat (`plugins/dia-chat/slots.ts`, exported)

```ts
/** Props of the request card: `request` is drawn; `onAnswer` is called once with the user's answer. */
export interface RequestCardProps { readonly request: Attention.UserInputRequest; readonly onAnswer: (answer: RunAnswer) => void }
/** The request card `dia-chat` provides. Read it with `useProvided(RequestCardKey)`. */
export const RequestCardKey: ServiceKey<ComponentType<RequestCardProps>>
```

### Renderer (`plugins/dia-inbox/renderer.ts`, `inbox-page.tsx`)

Adds the Inbox page. Each item shows the run's folder name and run id, the request card from `RequestCardKey`, and Show. An answer is sent with the `dia-runs` call matching its tag; the item leaves the list when `FollowInbox` drops it. The empty page reads "No agent is waiting for you."

## Refinement Record

Round 1 (inline, effort low):

**Applied**
- *Strategic Programming, major* — a first draft passed the three chat cards' different `onResolve` callbacks to the inbox; `RequestCardProps.onAnswer` now takes one `RunAnswer` for every request kind.
- *Correctness, minor* — `OpenRunInTab` selects the new tab on the host, but the renderer keeps the open page; D6 calls `actions.selectTab`, which closes it.

**Rejected**
- *Information Hiding, minor, `InboxItem.cwd` exposes run storage* — the folder is what the user reads to tell runs apart, not storage detail.

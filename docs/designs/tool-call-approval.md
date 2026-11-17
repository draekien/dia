# Tool call approval

Issue: draekien/dia#291. Decisions: ADR-0085 (amends ADR-0075).

`dia-tools` lets a dia tool handler ask the user to approve one call and wait for the answer, whatever the calling session's permission mode. The renderer shows each pending request in one dialog.

## Success criteria

1. A tool whose handler calls `requestApproval` returns `'approved'` after the user approves and `'declined'` after the user declines. The call does not pass through the session's `canUseTool`, so the permission mode does not change the outcome. (Test: `plugins/dia-tools/approvals.test.ts` (new) answers a pending request; `plugins/dia-tools/http-server.test.ts` calls a tool over HTTP that requests approval, answers it, and reads the tool result.)
2. Revoking a token while a request made under it is pending removes the request from the pending list, and the handler gets `'declined'`. Requests made under other tokens stay pending, including another token of the same run. A request made later under the revoked token returns `'declined'` at once. (Test: `approvals.test.ts` (new) for `declineScope`; `plugins/dia-tools/host.test.ts` (new) for `revoke` with two tokens of one run, and with two outside tokens.)
3. Closing the scope that built the approvals (a reload or unload of `dia-tools`) gives every pending handler `'declined'`, and a request made after that returns `'declined'` at once. (Test: `approvals.test.ts` closes the scope, then requests again.)
4. Cancelling a pending call (its `extra.signal` aborts) removes its request from the pending list. (Test: `http-server.test.ts` cancels the client request.)
5. The dialog shows the request's title, where it came from, and its before and after text, and it closes after Approve or Decline. Escape and a click on the overlay leave it open. (Test: `plugins/dia-tools/approval-dialog.test.tsx` (new); app: criterion 6.)
6. With `dia-example` loaded from Settings › Plugins, an agent's `example_approval` call opens the dialog, and the tool result names the answer given. (App.)
7. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.

## Interface

### `plugins/dia-tools/tools.ts` (exported module)

```ts
/** What a tool asks the user to approve: `title` names the change; `before` and `after` show it. */
export const ApprovalRequest = Schema.Struct({
  title: Schema.NonEmptyString,
  before: Schema.String,
  after: Schema.String
})
/** The decoded type of {@link ApprovalRequest}. */
export type ApprovalRequest = typeof ApprovalRequest.Type

/** The user's answer to an {@link ApprovalRequest}. */
export const ApprovalAnswer = Schema.Literals(['approved', 'declined'])
/** The decoded type of {@link ApprovalAnswer}. */
export type ApprovalAnswer = typeof ApprovalAnswer.Type

export interface Tools {
  // ...existing members...
  /**
   * Shows `request` to the user as coming from `scope` and waits for the answer. Pass the scope
   * the tool handler received. Succeeds with 'declined' when the user declines, when the token
   * `scope` was granted under is revoked (the run ended), or when `dia-tools` closes; at once when
   * `dia-tools` has already closed. It has no timeout. Interrupting the effect withdraws the
   * request. A request made through a server from `mcpServer` is under no token: it ends when it
   * is answered, when its call is cancelled or its server closes, or when `dia-tools` closes, so
   * the caller that owns that server closes it when its run ends. (Tested: a request under a
   * scope no token holds ends only on an answer, a cancel or a close.)
   */
  readonly requestApproval: (
    scope: ToolScope,
    request: ApprovalRequest
  ) => Effect.Effect<ApprovalAnswer>
}
```

`isTools` also checks `requestApproval` is a function. The `grant` line of the `Tools` JSDoc gains: "The scope is stored as a copy, so a handler receives an equal scope, not the object passed to `grant`." The `mcpServer` line gains: "Close the server when the run ends: its pending approvals end only then."

### `plugins/dia-tools/calls.ts`

```ts
/** A dia run started in `project` (its source directory, null when unknown) with `labels` asked for approval; the dialog shows both. */
export const RunSource = Schema.TaggedStruct('RunSource', {
  project: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String)
})
/** An agent outside dia asked for approval. */
export const OutsideSource = Schema.TaggedStruct('OutsideSource', {})
/** Where a pending approval came from. Build values with `RunSource.make` and `OutsideSource.make`. */
export const ApprovalSource = Schema.Union([RunSource, OutsideSource])
/** The decoded type of {@link ApprovalSource}. */
export type ApprovalSource = typeof ApprovalSource.Type

/** One request waiting for the user. `id` is a random UUID, so it is never reused after a reload. */
export const PendingApproval = Schema.Struct({
  id: Schema.String,
  source: ApprovalSource,
  request: ApprovalRequest
})
/** The decoded type of {@link PendingApproval}. */
export type PendingApproval = typeof PendingApproval.Type

/** Streams the pending approvals, oldest first: the current list, then the list after each change. */
export const WatchApprovals = Rpc.make('WatchApprovals', {
  payload: {},
  success: Schema.Array(PendingApproval),
  stream: true
})

/**
 * Records the user's answer to pending approval `id`. The first answer for an `id` wins; a later
 * call with that `id`, or an `id` that is no longer pending, is ignored, so a resent call is safe.
 */
export const AnswerApproval = Rpc.make('AnswerApproval', {
  payload: { id: Schema.String, answer: ApprovalAnswer }
})
```

### `plugins/dia-example/host.ts`

Inside `ctx.whenProvided([ToolsKey], ({ tools }) => ...)`, `dia-example` registers `example_approval` with `when: isRunScope`. Input `{ change: Schema.NonEmptyString }`. The handler calls `tools.requestApproval(scope, { title: 'Apply an example change', before: '', after: input.change })` and returns `The user approved the change.` or `The user declined the change.` It logs the answer.

## Internal decomposition

- **`approvals.ts`** — `makeApprovals` (scoped) returns `Approvals`: `request(scope, request)`, `pending` (`SubscriptionRef.changes` of the `PendingApproval` list, so each subscriber starts with the current list), `answer(id, answer)` and `declineScope(scope)`, which declines every request whose scope is that object (`===`) and remembers the object in a `WeakSet`, so a later `request` with it returns `'declined'` at once. It holds a `SubscriptionRef` of entries, each with its `ToolScope` and a `Deferred<ApprovalAnswer>`. `request` adds an entry, awaits its `Deferred`, and removes the entry when it completes or is interrupted. The finalizer marks the approvals closed and declines every entry; a `request` after that returns `'declined'` without adding an entry. Every request, answer, decline and withdrawal is logged by `id`, never with the `before` or `after` text, which may hold secrets. `Approvals` and `makeApprovals` carry JSDoc. `declineScope` is not on `Tools`.
- **`host.ts`** — builds the approvals after `serveMcp`, so the approvals finalizer runs first and every handler gets `'declined'` before the HTTP server closes. `registry.grant` (not the `Tools.grant` wrapper, because `makeOutsideTokens` grants through the registry with the shared `OUTSIDE_SCOPE`) stores `{ ...scope }`, so no two tokens share a scope object, outside tokens included. The HTTP server hands each MCP session the object `registry.scopeOf(hash)` returns (`http-server.ts:101`), so a handler's `scope` is that token's object. `revoke(hash)` reads `scopeOf(hash)` before revoking, calls `declineScope` with it, then revokes the hash and closes its sessions. Because `declineScope` remembers the scope, a call that reaches `requestApproval` between those steps also gets `'declined'`. `RevokeOutsideTokens` needs no extra step, since it revokes through `revoke`. `RunSource.project` is `scope.project ?? null`. Serves `WatchApprovals` and `AnswerApproval` after `makeApprovals`, so their subscriptions end before the approvals finalizer runs, and the stream uses only setup-scope resources (`api.ts` `serve`).
- **`http-server.ts`** — each session counts its running tool calls. Closing a session (`closeSessions`, or the endpoint closing) first waits up to one second for that count to reach zero, then closes the server. Without the wait, closing the server aborts `extra.signal` straight after `declineScope` and interrupts the handler before it resumes with `'declined'`.
- **`mcp-server.ts`** — `makeMcpServer` takes an optional `track` that wraps each tool call; `http-server.ts` passes the session's counter. The `CallToolRequestSchema` handler takes `(request, extra)` and calls `run(effect, { signal: extra.signal })`, so a cancelled call (`notifications/cancelled`, or the server closing: `@modelcontextprotocol/sdk` 1.32.2 `dist/esm/shared/protocol.js:173-180` and `262-266`; `RunOptions.signal` in `effect/src/Effect.ts:18536`) interrupts the handler and withdraws its request. `callTool` catches defects only, so the interruption reaches the handler and is not logged as a dead tool. The `ListTools` handler is unchanged.
- **`approval-dialog.tsx`** — `ApprovalDialog({ ctx, approvalsAtom })`, where `makeApprovalsAtom(ctx)` is an `Atom` of `followHost(ctx, WatchApprovals, {})`, as `dia-mcp/settings-page.tsx` does. `None` (the host entry not serving) counts as no pending requests. It shows the oldest pending request: the title; the source line `From a run in <last path segment of project>`, or `From a run` when `project` is null, followed by ` (<labels joined by ", ">)` when there are labels, or `From an agent outside dia`; `Before` and `After` blocks in monospace, with `(empty)` for an empty string; and `N more waiting` when others are queued. Approve (primary) and Decline (outline) call `AnswerApproval`. Built from `ui/alert-dialog.tsx`, which has no close button: `<AlertDialog open={pending.length > 0} onOpenChange={() => {}}>`; `open` is controlled and `onOpenChange` ignores every reason, so Escape and outside clicks leave it open. It closes only when no request is pending.
- **`DESIGN.md`** — gains an entry for the approval dialog: the title as heading, the source line, the two mono blocks (per the Content-Is-Mono Rule), Approve as the dialog's one primary action, and that it closes only on an answer.
- **`renderer.ts`** — `addEntry(ctx, DialogsSlot, { id: 'tool-approval', order: 100, component: () => createElement(ApprovalDialog, { ctx, approvalsAtom }) })`, importing `@dia-plugin/dia-layout/slots`.

## Design rationale

**`requestApproval` on `Tools`, not a third argument of `DiaTool.run`.** A plugin that registers tools already holds `Tools` from `whenProvided([ToolsKey], ...)`. A new `run` argument would change the kernel type in `src/host/session/dia-tools.ts` and every tool, for one capability that only `dia-tools` implements.

**The handler passes `scope`, and `requestApproval` trusts it.** The handler is host-side plugin code and receives the call's `ToolScope`. A handler that passes another scope shows the request under the wrong source and ties it to the wrong run; that is a bug in the handler, not a trust boundary.

**Revoking declines by token, compared by scope identity.** `dia-runs` revokes a run's token when the session that holds it closes (ADR-0075; a fresh token per session, `plugins/dia-runs/run-tools.ts`). Matching by `runId` would decline the requests of a newer session of the same run, and matching outside scopes by the absence of `runId` would decline every outside agent's requests. The granted scope object is the one value that belongs to exactly one token. The handler gets `'declined'` and does not apply the change, because closing the sessions waits up to one second for running calls to return. The agent's client may still see a closed connection instead of the tool result; the run has ended, so nothing reads that result. The same holds when `dia-tools` closes.

**Random UUID ids.** A counter restarts at 0 after a reload, so a renderer still showing an old request could answer a new request with the same id.

**No timeout.** The user may be away from the window; the request lasts as long as the run.

**Before and after shown as two blocks, not a line diff.** No diff library is installed, and #293 sends short JSON fragments, which two blocks show legibly.

**The dialog closes only on an answer.** A request that the user dismissed without answering would leave the run waiting with nothing on screen saying so.

## Rejected alternatives

**Use the session's `canUseTool` prompt.** The Agent SDK skips it under `bypassPermissions`, when an allow rule matches, and in `dontAsk` (`docs/reasoning/2026-10-24-phase-3-research-findings.md`).

**MCP elicitation (`elicitation/create`).** The request would go to the agent's client, not to dia's window. Which clients show it is unverified.

**A separate `ApprovalsKey` service.** Tool handlers already hold `Tools`; a second key adds a second `whenProvided` to every tool plugin, and approval has no use outside a tool call.

## Refinement Record

**Round 1 — applied**
- *Correctness* — ADR-0076 is taken (`docs/adr/0076-build-the-foundation-before-org.md`); the ADR is ADR-0085.
- *Correctness* — `revoke` reads `scopeOf` before revoking; an outside scope declines outside requests; the separate `RevokeOutsideTokens` step is removed as redundant.
- *Correctness* — `AnswerApproval` stated as first-answer-wins, safe to resend (`api.ts` `serve` docs).
- *Correctness* — `WatchApprovals` uses `SubscriptionRef.changes`; the dialog treats `None` as no requests.
- *Correctness* — `dia-example` is `load: manual`; criterion 6 (then 5) loads it first.
- *Correctness* — `DialogEntry.component` takes no props; `renderer.ts` binds `ctx` and the atom, as `dia-mcp` does.
- *Correctness* — `RunSource.project` mapping and the source line text stated.
- *Correctness* — the `extra.signal` change stated at the call site.
- *Project rules* — `RunSource` and `OutsideSource` extracted as named schemas with `.make`; schema-derived types and JSDoc on every export; logging stated, without request text.
- *Project rules* — "Escape is not a decision" replaced with a literal statement.
- *Project rules* — `host.test.ts` marked new.
- *Define Errors Out of Existence (recommended reading)* — the trust in the passed `scope` is stated in the rationale.
- *CQS* — `declineWhere` stated as internal.
- *POLA* — the dialog closes only on an answer.

**Round 2 — applied**
- *Correctness (blocker)* — revoke matched by `runId`; now by the granted scope object, with `grant` storing a copy per token.
- *Correctness* — the `mcpServer` path's end conditions stated in the JSDoc.
- *Fail Fast* — a request after the finalizer returns `'declined'` at once.
- *Correctness* — the dialog's component and props named; Escape and overlay test added.
- *Correctness* — cancelling a call is a success criterion with a test.
- *Project rules* — `DESIGN.md` entry for the dialog.
- *Strategic Programming* — `RunSource.labels` is now shown in the source line.
- *Correctness* — the `serve` scope order stated.

**Round 3 — applied**
- *Correctness (blocker)* — outside tokens are granted through `registry.grant` with one shared `OUTSIDE_SCOPE`; the copy moved into `registry.grant`, and a two-outside-tokens test added.
- *Correctness* — a call reaching `requestApproval` during `revoke` could stay pending; `declineScope` now remembers the scope in a `WeakSet`. The proposed alternative (decline when no token holds the scope) was not used, because a scope from `mcpServer` is held by no token and would always be declined.
- *Correctness* — the `mcpServer` JSDoc states its pending approvals end when the server closes, with a test.
- *Consistency* — criterion cross-references and "(new)" test files fixed.

**Round 3 — rejected**
- *Correctness, item 4* — "`extra.signal` abort on close and `runPromiseWith({ signal })` are unverified". Rejected: both were checked in the installed versions; the citations are now in the `mcp-server.ts` bullet.

**Implementation — changed**
- *Round 1, B2, reversed* — `plugins/dia-tools/host.test.ts` showed the declined handler interrupted before it resumed: the log has `Approval answered … declined` and no `Dia tool call returned` for that call. The wait was added where the interruption comes from, in `http-server.ts`'s session close, bounded to one second.
- The dialog uses `ui/alert-dialog.tsx` instead of `ui/dialog.tsx`, because the alert dialog has no close button and is the dialog for "what needs my answer now" (`DESIGN.md`, Shadow Vocabulary).

**Round 1 — rejected**
- *Correctness, B2* (reversed during implementation; see above) — "decline, then wait until every handler has returned before closing the sessions". Rejected: the response is written after the handler returns, so waiting for the handler does not ensure the client reads it, and the client is the run that has just ended. The requirement is that the handler gets `'declined'`; the rationale now says the client may see a closed connection.
- *Project rules, M7* — "invoke the required skills" is an implementation step, not spec content.

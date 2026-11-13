# `dia-run-messaging` plugin

Issue: draekien/dia#246, step 8 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0076 ("Agent-to-agent send, wait and delegate" row).

`dia-run-messaging` gives every dia run three dia tools: `run_send` sends a message to another run, `run_wait` waits until a run has finished its work and returns its last reply, and `run_delegate` starts a new run with a task and delivers that run's reply to the caller as a message when the run has finished. Org hands work over through issues (ADR-0069, ADR-0071) and does not use these tools.

Reference designs: t3code `delegate_task`, `t3_thread_send`, `t3_thread_wait` (`.repos/t3code/apps/server/src/mcp/toolkits/orchestrator/tools.ts`): a delegate's completion wakes the parent, a send to an idle thread starts it, and a wait on an idle thread returns at once. herdr `agent.prompt` starts a turn of the target; `agent.wait` blocks until the target is idle (https://herdr.dev/docs/, read 2026-11-13).

## Terms

A chat state has **nothing to run next** when `queued` is empty or `queueHeld` is true (the session holds its queue after an errored or parked turn, `message-queue.ts:137-139`). A run is **settled** when its chat state has no turn in progress (`isLoading` false) and nothing to run next. A run **finishes** at a chat state whose attention is `Completed`, `Errored`, `Crashed`, `ParkedToResume`, `ParkedUntilReset` or `ParkedForUser` and that has nothing to run next, judged only at the first state and at states produced by a `PaneAttentionChanged` or by a `PaneMessageQueueChanged` that holds the queue. A queue emptied after a turn end means its messages are being sent, so the state after it is not judged. A run's **reply** is the text parts of the last `assistant` message of its chat state. A message is **seen** in a chat state when a `user` message or a `queued` entry has exactly its text.

The chat states of a run are its snapshot (`RunEvents.snapshot`) followed by the snapshot folded with each later event of that run: committed events of the run with a sequence above the snapshot's `seq`, each turned into a pane event (a `StoredEvent` without `paneId` wrapped as `PaneAgentEvent`, as `projection.ts:89-95` does), kept when `PaneChat.isPaneStreamEvent`, and folded with `PaneChat.reducePaneChat(state, event, now)` where `now` comes from `Clock.currentTimeMillis`.

## Success criteria

1. Run A delegates a task to a new run B, and A's next turn starts with B's reply. (Test: `run_delegate` with scope run A starts a run with A's cwd, model, thinking level and permission mode; when B's log commits a reply and a `Completed` attention, `Runs.send(A, <text containing the reply>, 'queue')` is called once. App: a real run A calls `mcp__dia__run_delegate`, ends its turn, and its next turn starts with B's reply.)
2. `run_wait` on a run with a turn in progress returns that turn's reply and how it ended once the run finishes. (Test.)
3. `run_wait` on a settled live run, or on a run that is not live, returns its reply at once, including a run that is not live and has stored history. (Test.)
3a. `run_wait` on a run whose turn errors with a held queue returns `errored`. (Test.)
3b. A delegated run that finishes before the delivery fiber reads its snapshot is still delivered. (Test.)
4. `run_wait` on a run whose turn ends while a message is queued keeps waiting until the queued message's turn finishes. (Test: log commits `Completed` with `queued` non-empty, then `PaneMessageQueueChanged([])`, `PaneUserMessagesSent`, a reply and `Completed`; the result holds the second reply.)
5. `run_wait` returns a non-error "still working" result when its timeout passes, naming a request that waits for the user. (Test, `TestClock`.)
6. `run_send` sends `Message from run <A>:

<text>` to the target with mode `queue`, and returns once the target's log shows that text in a `PaneUserMessagesSent` or `PaneMessageQueueChanged`. (Test.)
7. `run_send` and `run_wait` to an unknown run, to an archived run, or to the caller itself, and a tool called with no `scope.runId`, return an error result and send nothing. (Test.)

## Decisions taken without the user

D1. **A message to a run wakes it.** `run_send` calls `Runs.send(target, text, 'queue')`: an idle live run starts a turn, a run with a turn in progress gets the message when that turn ends, and a run that is not live is opened from its row and starts a turn (what `Runs.send` already does). A delegate's reply reaches its caller the same way. This follows herdr `agent.prompt` and t3code `t3_thread_send` (`mode:'auto'` starts an idle thread). Alternative: a mailbox the target reads on its next turn, as paperclip @-mentions (rejected: it needs a store and a delivered flag, and a caller that ended its turn to wait for a delegate would never run again).

D2. **A plugin of its own, `plugins/dia-run-messaging`**, following ADR-0076's one plugin per capability. It composes `RunsKey`, `RunEventsKey` (both from `@dia/plugin`) and `ToolsKey` (`@dia-plugin/dia-tools/tools`) and registers its tools with `when: isRunScope`; it exports no module. Alternative: register the tools in `dia-runs` next to `plugin_*` (rejected: `dia-runs` would depend on the event log's chat state to read replies, and messaging would reload with sessions).

D3. **`run_delegate` starts B with `Runs.start`, not through the run queue.** `RunQueue.enqueue` completes once the run started; A is busy while its tool call waits, so with a limit of 1 the call would wait for its own turn to end, which never happens. B counts towards the queue's limit once started, because `Runs.busy` reports it. Alternative: enqueue and return before the start (rejected: the tool could not return B's id, and A could not `run_send` or `run_wait` it).

D4. **B inherits A's working directory (`RunInfo.cwd`, A's worktree when A has one), model, thinking level and permission mode.** B therefore edits the same files as A. `RunInfo` gains `model`, `thinkingLevel` and `permissionMode` from the run's row. B gets no labels and no context. A run never gets a broader permission mode than its delegator (t3code: "The target cannot run with broader modes than yours"). A permission request of B waits for the user (its inbox entry); B has not finished meanwhile, so A is not woken. Alternative: tool inputs for model and mode (rejected: no criterion needs them, and a mode input would let a run escalate).

D5. **Waiting reads the event log's committed events and folds them itself.** Every wait subscribes with `RunEvents.subscribe` before it acts (D11), then reads `RunEvents.snapshot(runId)` and folds each later event of the run onto it with `PaneChat.reducePaneChat`, checking the finish rule at each event. Folding, not re-reading the snapshot, is needed because at a turn end the session commits `Completed` and only then `PaneMessageQueueChanged([])` and, from a forked dispatch, `PaneUserMessagesSent` (`plugins/dia-claude-code/session.ts:613-620`, `:945`); a snapshot read between those two events shows a settled run that is about to start a turn. The finish rule depends on `dia-runs` committing a turn's last message before the attention that ends it; `Runs`' JSDoc states that order and a `run-registry.test.ts` test pins it. Alternative: `Runs.awaitIdle` (rejected: its turn flag is set before recording, so the reply may not be in the log yet, and it completes at once for a run `Runs.start` just returned). Alternative: a `RunEvents` member that waits for a turn end (rejected: one plugin needs it; it moves to the seam when a second does).

D6. **`run_wait` returns at once for a run that is not live or is settled**, with `Run <id> is idle. Its last reply:` (or `is not running` when not live); a run closed mid-turn keeps an in-memory `isLoading` that nothing will clear, so liveness, not `isLoading`, decides for it. How a run ended is named only from a finish the wait observed. A steer or interrupt by the user ends a wait early with the interrupted turn's reply (a steered message is dispatched with no queue event, `message-queue.ts:125-130`); the agent calls `run_wait` again. Before the snapshot it calls `RunEvents.seed(runId)`, which builds the chat state of a run that is not live from its stored log (`snapshot` alone serves an unseeded run as empty, `projection.ts:194-196`). Otherwise it waits until the run finishes. `timeoutSeconds` defaults to 300 and is at most 1800 (`Duration.seconds`); on timeout it returns `Run <id> is still working; call run_wait again.`, or `Run <id> waits for the user to answer a request.` when its attention is `AwaitingPermission`, as a non-error result. The result names how the run ended: `completed`, `errored`, `crashed` or `parked`.

D7. **`run_send` returns once the target's log shows the message**: the first `PaneUserMessagesSent` or `PaneMessageQueueChanged` of the target whose messages include the exact text sent, or after 30 seconds (`Runs.send` returns after opening a cold run and handing over the text, so only the recording lag remains) with a non-error "sent; not yet seen" result. A `run_wait` after `run_send` therefore sees the message as in progress or queued. Before sending it rejects an unknown or archived target and the caller itself; after `Runs.send` it returns an error when the target is not live (its open failed). Alternative: a `wait` flag on `run_send` (rejected: the issue names `run_wait` as a tool, and with D7 the two calls compose without the caller observing the log).

D8. **A delegated run reports back once, when it first finishes.** `run_delegate` subscribes, starts B, then follows B's chat states: it waits until the task is seen (then returns to A), and the delivery fiber waits for the first state from then on, that one included, at which B finishes. A finish already in the snapshot therefore counts, and a snapshot read before the task reached the log cannot look finished. The delivery waits on a fiber in the scope of the tools' `whenProvided`; a reload of `dia-runs`, `dia-run-events`, `dia-tools` or `dia-run-messaging` before then drops the delivery, logged at warning. Later turns of B (after a `run_send`) are read with `run_wait`. Like `run_send`, `run_delegate` returns once B's log shows the task (D7's rule and timeout). The delivered text names B's id and how it ended: `Run <B> completed the task you delegated. Its reply:` then the reply, or `Run <B> <errored|crashed|parked> before completing the task you delegated. Its last reply:` then the reply. Alternative: persist pending deliveries (rejected: no criterion needs a delivery to outlive a reload).

D9. **Any stored, unarchived run other than the caller is a target**, including a tab's run. `run_wait` on the caller itself is an error: the caller's own turn is in progress while it waits. Two runs waiting on each other end at their timeouts. Alternative: limit targets to runs the caller delegated (rejected: ADR-0076 names send as a general capability).

D11. **`RunEvents` gains `subscribe`, which subscribes at once.** `Stream.fromPubSub` subscribes on its first pull, not at `Stream.toPull` (`Channel.unwrap`; `docs/reasoning/2026-11-13-pubsub-stream-subscribes-on-first-pull.md`), so an event committed between the snapshot and the first pull was lost. `RunEventStore.subscribe` and `RunEvents.subscribe` are `Effect<Stream<CommittedEvent>, never, Scope>` built on `PubSub.subscribe`; `followRunChat` uses it too, which fixes the same gap there. `isRunEvents` requires it, so `PLUGIN_API_VERSION` goes from 0.0.41 to 0.0.42 with every `plugin.json`; the kernel's `RunEventLog` omits it. Alternative: prime the pull by racing it with a yield (rejected: it depends on fiber scheduling).

## Interface

### Kernel seam (`src/host/services/runs-seam.ts`)

```ts
/** One run as `Runs.list` reports it. `live` is true while its session runs. */
export interface RunInfo {
  readonly runId: string
  readonly cwd: string
  readonly model: string
  readonly thinkingLevel: ThinkingLevel
  readonly permissionMode: PermissionMode
  readonly sessionId: Option.Option<SessionId>
  readonly status: RunStatus
  readonly live: boolean
}
```

`Runs`' JSDoc gains: "A run's events reach its event log in the order its session emits them: a turn's last message is committed before the `PaneAttentionChanged` that ends the turn." `dia-runs`' `list` fills the new fields from the row's spec; the fake `RunInfo` in `plugins/dia-inbox/host.test.ts` gains them. `PLUGIN_API_VERSION` stays: `isRuns` is unchanged, `dia-runs` is the only provider, and a field added to a returned value breaks no reader.

### Tools (agents see `mcp__dia__<name>`)

| Name | Input | Result |
| --- | --- | --- |
| `run_send` | `{ runId: string, text: string }` | `Sent to run <id>.`, or the D7 texts |
| `run_wait` | `{ runId: string, timeoutSeconds?: int 1–1800 }` | `Run <id> <ended how>. Its last reply:` and the reply (`(no reply)` when empty), or the D6 timeout texts |
| `run_delegate` | `{ task: string }` | `Started run <B> in <cwd>. Its reply arrives as your next message; end your turn to wait for it.` |

The caller's run id is `scope.runId`; a scope without one gets an error result.

### Plugin internals

- `plugin.json`: `name: dia-run-messaging`, `category: feature`, `host: host.ts`, `load: eager`, no exports.
- `turns.ts`: the waiting rules: `watchRun(runEvents)` (scoped; subscribes, then returns the function that reads a run's snapshot and streams it and each later state as a `RunStep`, the state with the event that produced it), `finishOf(step)` (how the run ended and its reply), `isSettled(state)`, `isSeen(state, text)`, `replyOf(state)`.
- `messaging.ts`: `makeMessagingTools({ runs, runEvents })` returns the three `DiaTool`s; the delegate delivery fiber is forked into the calling scope. Logs each call and each delivery at info, a dropped delivery or a timed-out wait at warning.
- `host.ts`: `ctx.whenProvided([RunsKey, RunEventsKey, ToolsKey], …)` builds the tools and registers each with `when: isRunScope`.
- Every export carries JSDoc stating its contract. Timeouts use `Duration`; tests drive them with `TestClock`.

## Refinement Record

Round 1 (subagent, sonnet):

**Applied**
- *Correctness, blocker* — a run that is not live has no chat state, so `run_wait` returned `(no reply)`. D6 calls `seed` first.
- *Correctness, blocker* — at a turn end the log shows an empty queue before the queued message's `PaneUserMessagesSent`, so a snapshot read there saw a settled run. D5 folds events and judges each turn end on the state at that event; criterion 4 tests it.
- *Correctness, blocker* — `run_wait` on the caller itself waited for its own turn. D9 makes it an error.
- *Information Hiding, blocker* — the ordering of a turn's reply and its ending attention was a `live-run.ts` internal. D5 states it in `Runs`' JSDoc and pins it with a test.
- *Correctness, major* — the "seen" event matched any message. D7 matches the exact text.
- *Correctness, major* — `Runs.send` drops a send to an archived or unknown run, and after a failed open. D7 checks before and after.
- *Correctness, major* — results did not say how the run ended or that it waits for the user. D6 and D8 name the end; the timeout text names a waiting request.
- *Correctness, major* — a delegate waiting for permission never wakes A. D4 states it: the request is the user's to answer in the inbox.
- *Correctness, minor* — B shares A's worktree (D4); a scope without `runId` is an error; the API version reasoning cites the single provider; `Duration`/`TestClock` stated; "settled" and "finishes" defined once in Terms.

- *Correctness, major* — a `run_wait` on B right after `run_delegate` could read B before its turn reached the log. `run_delegate` returns once B's log shows the task, as `run_send` does (D7).

**Rejected**
- *Information Hiding and Strategic Programming, major, move the wait into the `RunEvents` seam* — one plugin uses it; `turns.ts` holds the whole protocol so the tools do not repeat it. Recorded as D5's alternative.
- *Avoid Temporal Decomposition, major, a `wait` flag on `run_send`* — the issue names `run_wait`; with D7 a caller needs no knowledge of the log to compose them.

Round 2 (subagent, sonnet):

**Applied**
- *Correctness, major* — an errored or parked turn holds its queue, so "no queued message" never held and `run_wait` hung. Terms define "nothing to run next" as an empty or held queue; criterion 3a.
- *Correctness, major* — the delegate delivery could miss a finish committed before its snapshot, or fire on a snapshot read before the task was logged. D8 waits for the task to be seen, then for a finish from that state on; criterion 3b.
- *Correctness, major* — a run closed mid-turn keeps `isLoading` true in memory. D6 returns at once for a run that is not live.
- *Information Hiding, minor* — the fold's steps (wrapping, filtering, sequence, `now` from `Clock`) are listed in Terms.
- *Correctness, minor* — the at-once result says `idle`; how a run ended comes only from an observed finish; a user's steer ends a wait early (D6); `run_send`'s timeout is 30 s and its text format is exact.

**Rejected**
- *Define Errors Out, minor, tell A when B waits for the user* — the request appears in the inbox and B's tab; no criterion needs A to know.
- *Unverified, minor, the MCP client's tool-call timeout* — not a design change; the app verification runs a `run_wait` through `mcp__dia__run_wait`.

Round 3 (inline):

**Applied**
- *Correctness, blocker (found by the tests)* — `Stream.toPull` of `committed` does not subscribe, so D5's "subscribe before acting" did not hold. D11 adds an eager `subscribe`.
- *Correctness, major (found by the tests)* — judging every state let a `PaneMessageQueueChanged([])` after a `Completed` count as a finish with the old reply. Terms now judge only the first state, attention changes and held queues.
- *Correctness, minor* — a delegate whose first turn ended more than 3 s before its snapshot shows `Idle` attention again (`live-run.ts:396-403`) and would never finish. The snapshot is read right after `Runs.start` returns, before the model has answered; recorded as an accepted gap.

No blocker or major finding remains.

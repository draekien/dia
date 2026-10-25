# `shouldQuery: false` sends several user messages as one turn

**Date:** 2026-10-25

## Context

The message queue (`docs/designs/message-queue-and-steer.md`) sends every queued message as one turn when the running turn ends, with each message kept as its own user message. The Agent SDK has no batch API. The question was how to offer n messages on the streaming input so the agent answers once, from all n.

## Reasoning / Learning

Observed with Agent SDK 0.3.207 and a repro script (`F:/Dev/dia-verify/combined-turn-repro.mjs`, outside the repo) that offers three messages: "Remember the word apple.", "Remember the word river.", and "Now reply with every word you were asked to remember, comma separated, nothing else."

Offered as plain `SDKUserMessage`s, the CLI's own queue decides the turns:

```text
4673 user   "Remember the word apple."                       isReplay
5044 result num_turns 1
6488 user   "Remember the word river.\nNow reply with ..."   isReplay
6875 result num_turns 1
```

The first message ran as its own turn. The other two were coalesced into one user message, joined with `\n`. The transcript no longer has one user record per message, so a coalesced message has no checkpoint uuid of its own.

Offered with `shouldQuery: false` on the first n − 1 messages (`sdk.d.ts` line 4455: "When false, the message is appended to the transcript without triggering an assistant turn"):

```text
2971 user      "Remember the word apple."   isReplay
2972 result    num_turns 0
2976 user      "Remember the word river."   isReplay
2976 result    num_turns 0
4205 user      "Now reply with ..."         isReplay
4310 assistant "apple, river"
4660 result    num_turns 1
```

Each message is replayed as its own user record with its own uuid, and one assistant turn answers from all three. Each `shouldQuery: false` message also produces a `result` with `num_turns: 0`, about 1 ms after the message is offered. The session reducer maps every `result` to `TurnCompleted`, so without a guard each silent result ends the visible turn early.

## Implication

- `offerBatch` in `plugins/claude-code/session.ts` adds n − 1 to `silentResultsRef` before offering any message, and `forward` drops one `TurnCompleted` per count. The count is raised before the first offer because the silent result can arrive before the next offer runs.
- A `TurnErrored`, a thinking-level restart and a rewind reset the count to 0, so a batch cut short does not swallow a later real turn end.
- The silent-result drop runs before the `abortExpectedRef` suppression, so a silent result does not consume an expected abort.
- Unverified: whether `query.interrupt()` sent right after an offer aborts the turn that offer starts.

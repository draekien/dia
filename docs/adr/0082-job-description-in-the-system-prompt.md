---
status: "accepted"
date: 2026-11-15
decision-makers: William Pei
---

# A job title's job description is appended to its run's system prompt

## Context and Problem Statement

ADR-0080 made a job title's job description the first paragraph of its run's first message, because `Runs.start` took nothing else that could carry it. The sidebar's Assistant entry (ADR-0081) should open the assistant as a normal empty thread, with the composer centred, before the user has typed anything. A run whose job description rides on its first message cannot exist before that message. Where should a job description go so that a run can start without a message?

## Decision Drivers

* The Assistant entry opens the normal thread view, not a separate request form.
* A run must keep its job description after a restart and after `/clear`.
* One rule for every job title, not one for the assistant and another for hires.

## Considered Options

* Append the job description to the run's system prompt
* Keep it in the first message, and draw a look-alike empty thread until the first message

## Decision Outcome

Chosen option: "Append the job description to the run's system prompt", because it lets a run start empty and keeps the job description out of the conversation, where `/clear` and compaction can drop it.

* `StartRunOptions` gains `systemPromptAppend`; `text` becomes optional, and a run started without it waits for its first message.
* `RunSpec` gains `systemPromptAppend`. `dia-runs` stores it in the run's spec and appends it after dia's session additions (`SessionAdditions.systemPromptAppend`) on every session the run opens, including after a restart.
* `dia-org` passes every job title's job description as `systemPromptAppend`, for hires' issue runs and for the Executive assistant. The first message holds only the work or the request. This replaces ADR-0080's "a job title's job description is the first paragraph of the run's first message".
* `OpenAssistant` returns the assistant's run, starting an empty one when it has none. The Assistant page calls it and shows the run's tab.

### Consequences

* Good, because the Assistant entry shows the normal thread view with its composer, model and permission pickers from the first click.
* Good, because `/clear` and compaction no longer remove the job description from a run.
* Bad, because the job description is no longer visible in the transcript; the user reads it on the job title's page.
* Bad, because a run started before this change keeps its job description in its first message and gets none appended.

## Pros and Cons of the Options

### Append the job description to the run's system prompt

* Good, because a run can exist before its first message.
* Bad, because `StartRunOptions`, `RunSpec` and the stored spec gain a field.

### Keep it in the first message, and draw a look-alike empty thread

* Good, because `Runs.start` does not change.
* Bad, because the look-alike repeats the composer without its pickers, and the job description still leaves the context on `/clear`.

## More Information

Amends ADR-0080. Design: `docs/designs/threads-and-agents.md` D3. The append uses the Agent SDK's `systemPrompt: { type: 'preset', preset: 'claude_code', append }` option, which `plugins/dia-claude-code/session-additions.ts` already builds.

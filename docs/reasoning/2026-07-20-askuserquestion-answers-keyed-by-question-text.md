# AskUserQuestion answers must be keyed by question text, not header

**Date:** 2026-07-20

## Context

`AskUserQuestion` prompts rendered in the clarifying-question card, the user
selected answers and submitted, but the tool result came back "The user did not
answer the questions." Bullet 06 T8 had previously recorded header-keying as
"confirmed correct against the real SDK."

## Reasoning / Learning

dia answers an `AskUserQuestion` call by resolving `canUseTool` with
`{ behavior: 'allow', updatedInput: { questions, answers, response? } }` — the
shape of the SDK's `AskUserQuestionOutput`. The CLI matches each asked question
to its answer **by the question's full text**: `AskUserQuestionOutput.answers`
is documented (`sdk-tools.d.ts`) as "question text -> answer string".

`clarifying-question-card.tsx` keyed the `answers` map by `questionKey`, which
returned `question.header` (falling back to text only when header was empty).
Header is a short chip label (e.g. "Isolation", "Instance lock") — not the
question text — so no answer key matched any question, and the CLI reported all
questions unanswered. This is an SDK behavior change: the T8-era verification
that header-keying worked no longer holds against the bundled CLI
(`@anthropic-ai/claude-agent-sdk` 0.3.207).

Fix: `questionKey` now returns `question.question`. The card's internal state,
DOM ids, and the emitted `answers` map all key off that one value, so the
answers line up with the questions the SDK echoes back. (DOM ids then contain
spaces, as multi-word headers already did; label/`htmlFor` matching and Radix's
value-based selection are unaffected.)

## Implication

The answer key is an SDK contract, not a free choice — keep it equal to
`question.question`. This is only truly verifiable against a live CLI, not a
unit test (the CLI, not dia, does the matching); verify in a real dev session.
The historical "header keying confirmed" note in the Bullet 06 breakdown is
superseded by this entry.

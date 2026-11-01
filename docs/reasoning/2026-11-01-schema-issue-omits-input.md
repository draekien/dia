# A Schema decode issue omits the rejected value unless `reportInput` is set

**Date:** 2026-11-01

## Context

The workspace problems list (#97) shows why a stored agent did not load, using the `message` of the `SchemaError` from `Schema.decodeUnknownResult(Tab)`. For `thinking_level = 'ultra'` the message read `Expected "off" | "adaptive" | "low" | "medium" | "high" | "xhigh" | "max"` followed by the path `["config"]["thinkingLevel"]`, with no mention of `"ultra"`.

## Reasoning / Learning

In Effect 4 the default formatter appends `, got <value>` only when the issue carries an `input` property (`SchemaIssue.hasInput`). A union issue (`AnyOf`, which `Schema.Literals` produces) keeps its input only when the parse option `reportInput: true` is set. Passing the option at decoder creation, `Schema.decodeUnknownResult(Tab, { reportInput: true })`, makes the message read `Expected "off" | … | "max", got "ultra"` with the same path line.

## Implication

Create a decoder with `{ reportInput: true }` when its issue message is shown to the user or must name the rejected value. `WorkspaceStore` does this for `Project` and `Tab`. The option copies the rejected value into the message, so do not set it on a decoder whose input can hold a secret.

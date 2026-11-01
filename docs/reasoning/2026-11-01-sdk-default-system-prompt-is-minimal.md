# The Agent SDK's default system prompt is not Claude Code's

**Date:** 2026-11-01

## Context

Issue #16 adds a system-prompt append to every agent. Before it, `plugins/claude-code/session.ts` passed no `systemPrompt` to `query()`.

## Reasoning / Learning

When `systemPrompt` is not set, the TypeScript Agent SDK uses a minimal prompt that covers tool calling and omits the rest of the `claude_code` preset, including its tool guidance and its security and safety instructions. This differs from `claude -p`, which uses the Claude Code prompt by default (https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts.md, "How system prompts work", read 2026-11-01 for SDK 0.3.311). So every dia agent before #16 ran on the minimal prompt, although ADR-0037 runs the user's own Claude Code install.

An `append` is only accepted on the preset form `{ type: 'preset', preset: 'claude_code', append }`. The SDK records the rendered system prompt on a conversation's first request and reuses it on `resume` (the `snapshot` default), so an append changed later does not reach a resumed conversation until it is compacted.

## Implication

The claude-code adapter always passes the `claude_code` preset, with or without an append (`plugins/claude-code/session-additions.ts`). Do not drop `systemPrompt` when the append is empty. Expect a resumed conversation to keep the append it started with.

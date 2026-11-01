# Image blocks work in streaming input; `applyFlagSettings` widens Read to a live query

**Date:** 2026-11-01

## Context

Composer attachments (#74) send images as content blocks and other files and folders as absolute paths. Two things were unknown on Agent SDK 0.3.311: whether a streaming-input `SDKUserMessage` accepts `image` blocks, and whether the agent can read an attached path outside the session's `cwd` without a permission prompt, on a query that is already running.

## Reasoning / Learning

A probe ran a `query` with streaming input, `permissionMode: 'default'` and a `canUseTool` that logs and denies every request:

- A first message with content `[{ type: 'text' }, { type: 'image', source: { type: 'base64', media_type: 'image/png' } }]` was answered correctly ("Red" for a 32×32 red PNG).
- A second message asking the agent to Read a file in a directory outside `cwd` asked `canUseTool` for permission.
- With `await query.applyFlagSettings({ permissions: { additionalDirectories: [dir] } })` called between the two turns, the same Read ran without calling `canUseTool`. The setting applies to the running query; it does not need `additionalDirectories` at query start.

`additionalDirectories` widens only the file tools. In the app, Haiku first tried to read the attached paths with a PowerShell command, which asks for permission like any shell command; told to use Read, it read the outside file with no prompt.

## Implication

The claude-code session calls `applyFlagSettings` with the union of every outside directory attached so far before it sends the message, and starts a restarted query with that union as `additionalDirectories`. Do not add a permission rule per attached path.

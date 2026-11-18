---
status: accepted
date: 2026-11-18
decision-makers: William Pei
---

# A Host plugin renames a tab through `ctx.renameTab`, and agent adapters offer one-shot text generation

## Context and Problem Statement

`dia-text-generation` titles a thread after its first user message. Tab names live in the kernel's `PaneWorkspace`. `HostPluginContext` (`src/shared/plugin/api.ts`) gives a Host plugin the workspace only as a read stream (`ctx.workspace`); the only rename path is the `RenameTab` RPC, which the renderer calls. The title comes from a model, and the only code that reaches a model is an agent adapter's `AgentBackend`, which runs sessions and has no one-shot call. How does a Host plugin rename a tab, and how does it get text from an adapter?

## Decision Drivers

* A title must be written while no window is open.
* ADR-0019 keeps the kernel thin: a context member must be one a feature cannot build itself.
* A consumer picks an adapter by what it offers (ADR-0086).

## Considered Options

* `ctx.renameTab` on `HostPluginContext`, and an optional `textGeneration` capability on the adapter registration
* The renderer renames the tab after a Host call returns the title
* `AgentBackend.generateText` on every adapter

## Decision Outcome

Chosen option: "`ctx.renameTab` on `HostPluginContext`, and an optional `textGeneration` capability on the adapter registration", because it writes titles without a window and leaves adapters that cannot generate text unchanged.

* `ctx.renameTab(paneId, name)` renames a tab and fails with `TabNotFoundError` when no tab has that id. It applies no owner check, matching the `RenameTab` RPC.
* `PaneWorkspace` requires `HostPlugins`, so `HostPlugins` reaches `PaneWorkspace.renameTab` through a `TabRenamer` service that `PaneWorkspaceLive` fills when it is built.
* `register(ctx, { label, backend, textGeneration? })`. `TextGeneration` is `{ defaultModel, generate({ instructions, input, model, effort }) }`; `generate` runs with no tools and no stored session.
* `PLUGIN_API_VERSION` and every `plugin.json` `api` change to `0.0.46`.

The design is `docs/designs/text-generation.md`. This ADR amends ADR-0019 (the Host plugin context gains a workspace write) and ADR-0086 (the registration gains an optional capability; `backend` stays required until an adapter without sessions exists).

### Consequences

* Good, because any Host plugin can name a tab it does not own, for example from an agent's summary.
* Good, because a second adapter offers text generation by passing one more field to `register`.
* Bad, because a Host plugin can rename a user's tab without the user's action; `dia-text-generation` limits itself to tabs with generated names and to the user's "Regenerate title".

## Pros and Cons of the Options

### The renderer renames the tab after a Host call returns the title

* Bad, because a thread whose first message arrives while no window is open keeps its generated name.

### `AgentBackend.generateText` on every adapter

* Bad, because every adapter would have to implement a call it may not support, and a consumer could not tell which adapters offer it.

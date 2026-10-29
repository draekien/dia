---
status: "accepted"
date: 2026-10-29
decision-makers: William Pei
---

# The chat plugin fills a `main.tab` slot inside the kernel's `main` default

## Context and Problem Statement

ADR-0031 kept kernel defaults for `main` and `main.header` "because plugins cannot import the chat", and expected them to change once the chat became a plugin (issue #9, `plugins/chat`). The kernel's `main` default, `TabContent`, draws four views: the visible tab (the chat), the New agent form, the first-run screen and the empty-project prompt. Which slot does the chat plugin fill, and what does the window show while it is not loaded?

## Decision Drivers

* Unloading a feature plugin must leave the rest of dia usable, as with `worktrees` (ADR-0029): with the chat unloaded the user must still be able to register a project and create an agent.
* The user chose an empty state, not a kernel chat, for a tab while the chat plugin is not loaded (2026-10-29).
* A shipped plugin cannot import `src/`.

## Considered Options

* The chat fills a new `main.tab` slot rendered by the kernel's `main` default for the visible tab only
* The chat fills `main` and takes over all four views

## Decision Outcome

Chosen option: "The chat fills a new `main.tab` slot", because the user chose it (2026-10-29): only the chat disappears when the plugin is unloaded.

This amends ADR-0031's slot table:

| ADR-0031 row | Now |
| --- | --- |
| Child slots: `sidebar` and `main` (rendered by `plugins/layout`), `main.header` | Adds `main.tab`, rendered by the kernel's `main` default (`TabContent`) for the visible tab only |
| Kernel defaults: `main` and `main.header` render kernel components | `main` and `main.header` keep their kernel defaults. `main.tab` has none; while it is empty, `TabContent` shows "No chat plugin is loaded" |

### Consequences

* Good, because first run, an empty project and the New agent form work with the chat unloaded.
* Good, because chat state stays in the kernel's atoms and query cache, so reloading the plugin keeps every pane's transcript and pending requests.
* Bad, because `@dia/renderer-plugin` exports about forty more names (chat atoms, hooks, helpers, shadcn primitives), each a stable API for plugins.
* Bad, because the transcript width button stays in the kernel's `main.header` default and still shows on a tab while the chat is unloaded.

## Pros and Cons of the Options

### The chat fills `main.tab`

* Good, because the kernel keeps the screens that do not depend on the chat.
* Bad, because it adds a slot and a context the plugin reads to know the tab was opened from the New agent form.

### The chat fills `main`

* Good, because it needs no new slot.
* Bad, because unloading the chat also removes the first-run screen and the New agent form.

## More Information

* Design: `docs/designs/chat-plugin.md`.
* Related: ADR-0029, ADR-0031, ADR-0032, ADR-0038.

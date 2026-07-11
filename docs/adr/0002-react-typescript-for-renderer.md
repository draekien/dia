---
status: "accepted"
date: 2026-07-11
decision-makers: William Pei
---

# Use React with TypeScript for the renderer

## Context and Problem Statement

The Electron renderer process needs a UI framework to build the chat interface (conversation view, message composer, settings, tool-call/permission dialogs). Which framework and language should the renderer use?

## Decision Drivers

* Consistency with the rest of the stack, which is TypeScript end-to-end (Agent SDK, main process).
* Availability of pre-built accessible UI primitives suitable for a chat-style application.
* Ease of finding examples, libraries, and community solutions.

## Considered Options

* React + TypeScript
* Svelte + TypeScript

## Decision Outcome

Chosen option: "React + TypeScript", because it keeps the entire codebase in one language across main, preload, and renderer, and it has the largest ecosystem of components and examples for building chat/agent UIs, including shadcn/ui which this project also adopts (see [ADR-0005](0005-tailwind-and-shadcn-ui-for-styling.md)).

### Consequences

* Good, because TypeScript is shared across the whole app with no context-switching between languages.
* Good, because the component ecosystem (shadcn/ui, Radix primitives) is large and well suited to this app's needs.
* Bad, because React carries more boilerplate and a larger runtime than Svelte for equivalent UI.

## Pros and Cons of the Options

### React + TypeScript

* Good, because it has the largest ecosystem of components, examples, and hiring/community familiarity.
* Good, because shadcn/ui (built on React + Radix) provides accessible, unstyled primitives that fit a chat UI well.
* Bad, because it is more verbose than Svelte for equivalent functionality.

### Svelte + TypeScript

* Good, because it produces smaller bundles and less boilerplate.
* Bad, because its component ecosystem for chat-style UIs is smaller than React's.

## More Information

None.

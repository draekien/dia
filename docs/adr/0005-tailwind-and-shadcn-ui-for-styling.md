---
status: "accepted"
date: 2026-07-11
decision-makers: William Pei
---

# Use Tailwind CSS and shadcn/ui for renderer styling

## Context and Problem Statement

The renderer (React + TypeScript, see [ADR-0002](0002-react-typescript-for-renderer.md)) needs a styling approach and a set of UI primitives suitable for building a chat application: message lists, composers, dialogs, and settings panels. What should this project use?

## Decision Drivers

* Speed of building an accessible, polished chat UI without hand-rolling every primitive.
* Existing tooling already available in this environment (shadcn MCP/skill integration).
* Preference for utility-first styling over hand-written CSS/CSS Modules for velocity.

## Considered Options

* Tailwind CSS + shadcn/ui
* Plain CSS / CSS Modules

## Decision Outcome

Chosen option: "Tailwind CSS + shadcn/ui", because shadcn/ui provides accessible, Radix-based primitives (dialogs, dropdowns, tooltips, etc.) that map directly onto the components a chat UI needs, and Tailwind's utility classes pair with it out of the box. This project also already has shadcn tooling integrated into the working environment, reducing setup friction.

### Consequences

* Good, because accessible component primitives (dialogs, popovers, tooltips) don't need to be built from scratch.
* Good, because Tailwind keeps styling co-located with markup, avoiding a separate CSS file per component.
* Bad, because Tailwind's utility-class markup has a learning curve and can make JSX more verbose.

## Pros and Cons of the Options

### Tailwind CSS + shadcn/ui

* Good, because it provides ready-made, accessible components suited to chat UIs.
* Good, because it's already integrated into the working environment (shadcn MCP/skill).
* Bad, because it introduces a build-time dependency (Tailwind's PostCSS pipeline) and a component copy-in workflow (shadcn components are copied into the repo, not installed as an opaque dependency).

### Plain CSS / CSS Modules

* Good, because it has no framework lock-in or utility-class learning curve.
* Bad, because every UI primitive (dialogs, dropdowns, tooltips) would need to be built and made accessible from scratch.

## More Information

None.

---
status: "accepted"
date: 2026-11-01
decision-makers: William Pei
---

# Build the shadcn/ui wrappers on Base UI instead of Radix

## Context and Problem Statement

[ADR-0005](0005-tailwind-and-shadcn-ui-for-styling.md) chose shadcn/ui and named Radix as the primitive library under its wrappers. shadcn/ui now publishes every component in two variants, one on Radix (`radix-*` styles) and one on Base UI (`base-*` styles). Which primitive library should the wrappers in `src/renderer/src/components/ui/` use?

## Decision Drivers

* The wrappers are re-exported to plugins through `@dia/renderer-plugin`, so their props are part of the plugin API.
* [ADR-0014](0014-tanstack-ai-usechat-for-renderer-chat-state.md) already composes shadcn's Base UI chat primitives (`Message`, `Bubble`, `MessageScroller`).
* The project owner asked for the whole renderer to move to Base UI.

## Considered Options

* Keep Radix (`radix-ui`)
* Move every wrapper to Base UI (`@base-ui/react`)

## Decision Outcome

Chosen option: "Move every wrapper to Base UI", because the project owner asked for it and it puts the remaining wrappers on the same primitive library as the chat primitives from ADR-0014. This extends ADR-0005: shadcn/ui and Tailwind stay; only the primitive library under the wrappers changes.

### Consequences

* Good, because one primitive library serves every wrapper, and `radix-ui` is no longer a direct dependency.
* Bad, because the wrapper API changed for every caller, plugins included: `asChild` is replaced by `render`, a toggle group's `value` is an array, `onValueChange` on a select can receive `null`, and a context menu item fires `onClick` instead of `onSelect`. `PLUGIN_API_VERSION` went from 0.0.16 to 0.0.17.
* Bad, because `components.json` keeps the style `new-york`, for which shadcn publishes no Base UI variant. `shadcn add` still delivers Radix code for that style, so a component added later must be converted by hand or the project must move to a `base-*` style.
* Neutral, because `cmdk` still depends on `@radix-ui/react-dialog`, so Radix packages remain in `pnpm-lock.yaml` as transitive dependencies.

## Pros and Cons of the Options

### Keep Radix

* Good, because no caller changes.
* Bad, because the wrappers and the chat primitives would keep using two primitive libraries.

### Move every wrapper to Base UI

* Good, because the wrappers match shadcn's `base-*` registry shapes for the parts they share.
* Bad, because the change breaks every plugin built against plugin API 0.0.16.

## More Information

The per-component record of the migration, including behaviour that differs from Radix, is in `.migration/<component>.md` at the repository root.

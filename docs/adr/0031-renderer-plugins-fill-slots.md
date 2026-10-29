---
status: "accepted, amended by ADR-0038 and ADR-0040"
date: 2026-10-25
decision-makers: William Pei
---

# Renderer plugins draw the UI by filling slots: one root slot, and child slots declared by the plugin that fills it

## Context and Problem Statement

ADR-0019 makes every user-facing feature replaceable by a plugin, but a renderer plugin could draw nothing: `PluginServices` offers only `provide` and `inject`, and `main.tsx` discarded the renderer registry. `docs/plans/2026-10-22-plugin-platform.md` left open what renderer plugins can replace: named slots only, or the whole layout. The agent overview sidebar (issue #13, ADR-0023) is the first renderer plugin that draws UI. How does a renderer plugin put UI on screen, and which parts can it replace?

## Decision Drivers

* ADR-0019 rejected "fixed core with extension points": a plugin must be able to replace the layout, not only add to places the kernel chose.
* The frame and the sidebar must be replaceable independently.
* The chat is still kernel code (issue #9 `plugins/chat`), and a shipped plugin cannot import `src/`.
* `deepseek-ai/deepseek-harness`, the model for dia's plugin platform (ADR-0019, ADR-0020), renders one built-in `root` slot and lets the plugin that fills it declare child slots (`docs/subsystems/slots.md:23`, `packages/client/ui-layout/README.md:30`, commit `22ddee3`).

## Considered Options

* One root slot; the plugin that fills it declares child slots
* One `layout` service key with no child slots
* A kernel-owned frame with named slots
* Kernel components first; plugins later

## Decision Outcome

Chosen option: "One root slot; the plugin that fills it declares child slots", because the user chose it (2026-10-25) after comparing it with deepseek-harness's model.

| Rule | Value |
| --- | --- |
| Kernel | Renders only `<AppHeader/>` and the `root` slot. With `root` empty it shows "No layout plugin is loaded" |
| Filling a slot | `fillSlot(ctx, name, Component)` from `@dia/renderer-plugin`. It provides the component under a private service key, so one plugin per slot, `ServiceKeyTakenError` for a second, and removal when the plugin's scope closes all come from the plugin registry |
| Slot kinds | `single` only; other kinds are added when a slot needs one |
| Child slots | Rendered with `<Slot name>` by the component that owns the region. The first set: `sidebar` and `main` (rendered by `plugins/layout`), `main.header` (rendered by the kernel's `main` default) |
| Kernel defaults | `main` and `main.header` render kernel components when no plugin fills them, because plugins cannot import the chat. `root` and `sidebar` have no default |
| State | Plugins read state through hooks and change it through actions exported by `@dia/renderer-plugin`; a plugin never calls another plugin |

### Consequences

* Good, because any region, including the frame, can be replaced without editing the plugin that owns its parent region.
* Good, because slots reuse the service-key registry; there is no second registry.
* Bad, because `@dia/renderer-plugin` must export every kernel component a plugin renders (status indicator, shadcn primitives), and keep those exports stable.
* Bad, because the `main` and `main.header` defaults are kernel code until the chat becomes a plugin.

## Pros and Cons of the Options

### One root slot; the plugin that fills it declares child slots

* Good, because it matches deepseek-harness and ADR-0019.
* Bad, because it needs a renderer plugin API module and a registry change stream.

### One `layout` service key with no child slots

* Good, because it has one key and less wiring.
* Bad, because replacing the sidebar means replacing the whole layout.

### A kernel-owned frame with named slots

* Good, because the frame is fixed and simple.
* Bad, because ADR-0019 rejected a fixed core with extension points.

### Kernel components first; plugins later

* Good, because it is the least work now.
* Bad, because it leaves issue #13 ("renderer built-in plugin") and the plan's open question unresolved.

## More Information

* Design: `docs/designs/agent-overview.md`.
* Related: ADR-0019, ADR-0020, ADR-0023, ADR-0027, ADR-0029.

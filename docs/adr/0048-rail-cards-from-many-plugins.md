---
status: "accepted"
date: 2026-11-01
decision-makers: William Pei
---

# Let many plugins add cards to the session rail

## Context and Problem Statement

The session rail (`docs/designs/session-rail.md`) shows cards about the visible agent: context usage, background tasks, the task list, and cards a user's own plugin adds. ADR-0019 makes every feature a plugin, so the rail must accept cards from any number of plugins. A renderer slot cannot do that:

```ts
fillSlot(ctx, MAIN_TAB, Chat)        // chat plugin: ok
fillSlot(ctx, MAIN_TAB, OtherCard)   // second plugin: fails with ServiceKeyTakenError
```

How does a plugin add a card that sits next to cards from other plugins?

## Decision Drivers

* Any number of plugins add cards, and a plugin's cards disappear when it unloads or reloads.
* Two plugins must not be able to break each other by choosing the same card id.
* The rail's look (card frame, title row, hide control) must not depend on each plugin getting it right.

## Considered Options

* A kernel card list that plugins add to inside their scope
* One plugin registry service key per card, found by key prefix
* A slot per card position (`rail.1`, `rail.2`, …)

## Decision Outcome

Chosen option: "A kernel card list that plugins add to inside their scope", because it supports many contributors and unload cleanup with no change to the plugin registry.

`addRailCard(ctx, { id, title, component })` adds the card to a renderer atom when it runs and removes it when the plugin's scope closes. The card's key is `<plugin name>.<id>` (`chat.context`), so ids cannot collide across plugins. The kernel renders the card frame; the plugin's `component` renders only the body and receives the pane id.

### Consequences

* Good, because a third-party card needs one call in its renderer setup.
* Good, because hiding, ordering and the card frame are the kernel's, the same for every card.
* Bad, because rail cards are a second extension mechanism next to slots, and a reader has to know both.
* Bad, because the plugin context gains exports, so `PLUGIN_API_VERSION` goes from 0.0.10 to 0.0.11 and every shipped `plugin.json` changes.

## Pros and Cons of the Options

### A kernel card list that plugins add to inside their scope

* Good, because the plugin's scope already closes on unload and reload.
* Bad, because the list lives outside the registry, so the plugin list does not show which cards a plugin added.

### One plugin registry service key per card, found by key prefix

* Good, because the registry already tracks providers.
* Bad, because `PluginRegistry` has no way to list keys, and `changes` reports only keys provided after subscription, so the registry would need a new method.

### A slot per card position

* Bad, because a fixed number of positions caps the cards, and two plugins still collide on a position.

## More Information

`src/renderer/src/lib/session-rail.ts` holds the list. `docs/designs/session-rail.md` has the full design.

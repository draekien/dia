# Session rail and centred composer

Shaped in conversation with the user on 2026-11-01 (`/impeccable shape`). The visual rules are in `DESIGN.md` > Components > Session rail and Composer. The decision to add a many-contributor extension point is ADR-0047.

## Scope

- A session rail: a column of floating cards at the right edge of the chat pane. Plugins add cards with `addRailCard`. The chat plugin adds three: Context, Background tasks and Task list.
- The context donut and the composer's `N in background` trigger are removed; their content moves to the Context and Background tasks cards.
- A composer that sits centred in an empty session and moves to the bottom after the first send.
- Composer layout: the settings move to a line under the box; the text area grows with its text; the send button is neutral while there is nothing to send.

Out of scope: the diff drawer (a later window-level column to the right of the session pane), drag reordering of cards, per-agent card visibility.

## Modules

### `src/renderer/src/lib/session-rail.ts` (kernel)

Owns which cards exist, which the user hid, whether the rail is on, and whether it is temporarily shown. Holds no chat knowledge.

```ts
/** A card a plugin adds to the session rail. `component` renders the card body for one pane. */
export interface RailCard {
  readonly id: string            // unique within the plugin, e.g. 'context'
  readonly title: string         // the card header, e.g. 'Context'
  readonly component: ComponentType<{ readonly paneId: PaneId }>
}

addRailCard(ctx: PluginServices, card: RailCard): Effect<void, never, Scope>
```

- A card's key is `${ctx.name}.${card.id}` (`chat.context`), so two plugins cannot collide. A plugin that adds the same id twice replaces its own earlier card; this is the hot-reload path.
- The card is removed when the plugin's scope closes (unload, reload).
- Cards are ordered by registration: the order `addRailCard` ran in.

State (atoms in `appRegistry`):

| Atom | Persisted | Meaning |
|---|---|---|
| `railCardsAtom` | no | Registered cards in order, with their keys |
| `railOpenAtom` | `localStorage` `dia.rail.open`, default on | The user's choice when there is room |
| `hiddenRailCardsAtom` | `localStorage` `dia.rail.hidden` (JSON array of keys) | Cards the user turned off |
| `railFitsAtom` | no | Whether the visible pane has room; written by the pane |
| `railPeekAtom` | no | The cards are shown over the transcript until focus returns to it |

Derived: `railShown = fits ? open : peek`. Recording a new `fits` value clears `peek`, so a temporary show never reappears after the pane widens and narrows again. A card is shown when `railShown` and its key is not hidden.

Exports through `@dia/renderer-plugin`:

| Export | For |
|---|---|
| `addRailCard(ctx, card)` | A plugin adding a card |
| `useRailLayout(width, columnMax)` | The chat pane: returns `{ fits, shiftLeft }` for its column and records `fits` for the header toggle. `fits` is `width >= columnMax + 320`; `shiftLeft` is `max(0, 320 - (width - columnMax) / 2)` while the cards fit and the rail is on, else 0 |
| `SessionRail({ paneId })` | The chat pane, which renders it where the cards belong |
| `useRailCardShown(key): boolean` and `revealRailCard(key)` | A plugin that warns when its card is not visible (the context caption) |

The header toggle (`RailToggle`) is kernel UI in `TabHeader` and is not exported.

### `src/renderer/src/components/session-rail.tsx` (kernel UI)

- `SessionRail` renders nothing unless `railShown`. When shown it renders, absolutely positioned at the pane's top right (16px in), one card per shown key, 288px wide, stacked with 8px gaps, scrolling when taller than the pane.
- Card frame: a hairline border, `bg-card` (the surface token, one step lighter than the pane), no shadow; a caption-size title row with a `⋯` icon button. The `⋯` popover lists every registered card with a checkbox; unchecking one hides it.
- When every card is hidden, one small card reads `All cards hidden` with a `Show cards` button that clears the hidden list.
- While `peek` is on: a `focusin` or `pointerdown` outside every element marked `data-session-rail` (the cards, their `⋯` popovers and the header toggle), or `Escape`, turns it off.
- `RailToggle` (in `TabHeader`, shown for a tab): an icon button (`PanelRight`), `aria-pressed` = `railShown`, with the shortcut `Ctrl Shift B` (`⌘ Shift B` on macOS). When the cards fit it flips `railOpen`; otherwise it flips `peek`.

### Chat plugin

- `plugins/chat/renderer.ts` adds the three cards after filling `main.tab`.
- `plugins/chat/context-card.tsx` (replaces `context-donut.tsx`): the donut popover's content, unchanged in behaviour: percentage, token counts, meter in `contextColor`, `Compact conversation`, the failure line. Before the first reading: `No usage yet`.
- `plugins/chat/background-tasks.tsx`: becomes the card body; one row per task description; empty: `None running`.
- `plugins/chat/task-list-card.tsx` with `latestTodos(messages)`: the `todos` of the last `TodoWrite` tool call in the transcript, each `{ content, status }` where `status` is `pending`, `in_progress` or `completed`; items that fail that shape are dropped. Rows show a status icon; the in-progress item is in foreground text, others muted, completed ones struck through. Empty: `No task list`.
- `plugins/chat/pane.tsx`:
  - Measures the scroller's width with a `ResizeObserver` and passes it to `useRailLayout` with `columnMax` 672, 768 or 1024px for Narrow, Default, Wide. It translates the column (transcript and composer) left by `shiftLeft`, so the column moves only as far as the cards need. The translate transitions over 200ms, off under reduced motion. A translate keeps both columns centred in their own containers, which a `margin-left` measured against the transcript's padding box would not.
  - Renders `SessionRail` unless the session is empty.
  - **Empty session:** no messages, no running turn and nothing queued. The composer overlay is translated so its centre sits at 45% of the pane height, with a caption line above it: the project name, then the worktree branch in mono when there is one. The scroll-to-end button and the fade above the composer are hidden. When the session stops being empty the translate transitions to zero over 250ms ease-out (instant under reduced motion).
- Composer:
  - The model, thinking and permission triggers move from the box's header row to a line under the box. Their label text lines up with the box's text.
  - The text area loses `min-h-14`; it starts one line tall, grows with its text, and scrolls past `max-h-60` (about 10 lines).
  - The box border changes to the ring colour on focus, over 150ms.
  - The action button uses `secondary` while it is a disabled submit and `default` when it can send, with a 150ms colour transition; a new icon fades in over 150ms. Both are off under reduced motion.
  - Only `bypassPermissions` (`Full access mode`) reads in foreground weight. `Auto mode` is muted like the other settings.
  - Context caption: while the `chat.context` card is not shown and the context is at 75% or more, or the last compaction failed, the settings line ends with `78% context` in the context colour. Clicking it calls `revealRailCard('chat.context')`, which unhides the card and turns the rail on (or peeks when it does not fit).

## Decisions

| Decision | Why |
|---|---|
| Cards live in a kernel atom, not in the plugin registry's service keys | A service key has one owner (`ServiceKeyTakenError`) and the registry cannot list keys by prefix. A scoped add/remove on an atom gives many contributors and unload cleanup without changing the registry. ADR-0047. |
| Card keys are `<plugin>.<id>` | Two plugins cannot collide, so no collision error has to exist. |
| Rail state in `localStorage`, not the Host settings store | Same as the sidebar's open state and width (`plugins/layout/layout.tsx`): a renderer-only view preference. Avoids an RPC and a `PROTOCOL_VERSION` bump. |
| The kernel renders the card frame; a plugin renders only the body | Every card gets the same title row, hide control and spacing, so a plugin card cannot break the rail's look. |
| The visibility checklist lives in each card's `⋯` popover | The rail has no panel or header of its own to hold a menu. |
| The column slides left instead of the cards covering text when there is room for both | Cards then need `column + 320px` instead of `column + 640px` (Default: 1088px instead of 1408px), so they are auto-hidden far less often. |
| Temporary cards also close on focus in the composer | The composer is in the transcript column; typing is the moment the cards are in the way. |
| `Ctrl Shift B` | `Ctrl B` toggles the sidebar and checks `!shiftKey`, so the two never both fire. |
| Context caption at 75% | The amber threshold of `contextColor`: below it the hidden card holds nothing that needs the user. |
| Only `Full access mode` is emphasised | The user said `Auto mode` is the safest mode; `bypassPermissions` skips every approval. |
| `PLUGIN_API_VERSION` 0.0.10 → 0.0.11 | The plugin context gains `addRailCard` and the rail exports, per the rule in `src/shared/plugin/manifest.ts`. |

## Success criteria

1. A new agent's composer is centred, with the project caption above it; after the first send it is at the bottom.
2. With the window wide enough, the three cards show at the right; the transcript column shifts left only when it must.
3. Narrowing the window hides the cards; the header button shows them over the transcript; clicking the transcript hides them again.
4. Unchecking a card in a `⋯` popover hides it, and the choice survives a reload.
5. Unloading the chat plugin removes its cards.
6. The composer has no donut and no `N in background`; the settings sit under the box.
7. At 75% context with the Context card hidden, `NN% context` shows under the composer and opens the card.

## Refinement record

One inline round (`--effort low --runner inline`); the user was away and asked for decisions to be recorded instead of asked.

| Finding | Tag | Outcome |
|---|---|---|
| Exporting `RAIL_SPACE` and `useRailOpen` made the pane do the rail's layout maths (Information Hiding). | major | Applied: `useRailLayout(width, columnMax)` returns `{ fits, shiftLeft }`. |
| `SessionRail` recorded `fits`, but it is not rendered in an empty session, so the header toggle read a stale value. | major | Applied: `useRailLayout` records `fits`. |
| `peek` stayed on when `fits` turned true and reappeared later (Define Errors Out of Existence). | minor | Applied: recording `fits` clears `peek`. |
| The `⋯` popover renders in a portal, so a click in it closed the temporary cards. | major | Applied: elements marked `data-session-rail` count as inside. |
| `revealRailCard('chat.context')` takes a string key (Law of Demeter). | minor | Rejected: the key is the plugin's fixed `plugin.json` name and its own card id. |

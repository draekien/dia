# Right panel

Issue #137 (part of #72). A region to the right of the transcript in each chat tab, drawn by the chat plugin, that any number of plugins add panels to. The diff viewer (#139) is the first plugin that will add one. The visual rules are in `DESIGN.md` › Components › Right panel.

Decisions confirmed with the user, which replace the issue's where they differ:

| Decision | Choice |
|---|---|
| How plugins add a panel | An entry in the chat plugin's list slot `PanelsSlot` (`chat.panels`), added with `addEntry(ctx, PanelsSlot, panel)`. ADR-0061 covers list slots, so there is no new ADR and no `PLUGIN_API_VERSION` bump. |
| Which tabs a panel applies to | Every chat tab. There is no `applies` hook. |
| Open state, selected panel, width | Per tab, session only: a renderer atom keyed by pane id. It survives tab switches and plugin reloads; after a restart every tab is closed. |
| Panel toggle | `PanelRight`, `Ctrl Alt B` (`⌘ ⌥ B` on macOS), hidden while `PanelsSlot` has no entries |
| Session rail toggle | Changes from `PanelRight` to `GalleryVerticalEnd`; keeps `Ctrl Shift B` |
| Session rail cards while the panel is open | They stay over the transcript area. Their fit rule measures the transcript area that remains beside the panel, so they hide on narrow windows and the rail toggle still shows them temporarily. |

## Success criteria

| # | Criterion |
|---|---|
| 1 | With no `PanelsSlot` entry, the header shows no panel toggle. |
| 2 | With the example panel added, the toggle shows with `PanelRight`, `aria-pressed=false`, and the region is closed. |
| 3 | Clicking the toggle or pressing `Ctrl Alt B` opens the region beside the transcript with a left border; again closes it. |
| 4 | Opening the panel on tab A leaves tab B closed; switching back to A shows it still open. |
| 5 | Dragging the divider changes the width; tab B keeps its own width; the transcript never goes below 400px. |
| 6 | With two panels added, the region shows a switcher; selecting one renders that panel's component with the pane id. |
| 7 | Unloading or reloading the example plugin removes its panel; when it was the last one, the toggle hides. |
| 8 | After a restart, every tab's panel is closed. |
| 9 | The session rail toggle shows `GalleryVerticalEnd` and `Ctrl Shift B` still works. |

## Modules

### `plugins/dia-chat/slots.ts`

```ts
/** A panel in the right panel region. The region draws the header with `title`; `component` draws the body. */
export interface Panel {
  readonly id: string
  readonly order: number
  readonly title: string
  readonly component: ComponentType<{ readonly paneId: PaneId }>
}

export const PanelsSlot = ListSlot.make<Panel>('chat.panels')
```

The chat plugin declares the list in `renderer.ts`, next to `RailCardsSlot`. A panel's key is `<plugin>.<id>`.

### `src/renderer/src/lib/right-panel.ts` (kernel)

Owns each tab's panel state and whether the visible tab has any panel. Holds no chat knowledge.

| State | Persisted | Meaning |
|---|---|---|
| per pane id: `open` | no | Whether the tab's region is shown. Default closed. |
| per pane id: `selected` | no | The key of the panel the user chose. Unset, or a key whose panel is gone, shows the first panel. |
| per pane id: `width` | no | The region's width in px. Default 400. |
| `panelsAvailable` | no | Whether the visible tab has any panel; written by `RightPanel`, read by the header toggle. |

`fitRightPanelWidth(width, paneWidth)` clamps a requested width to at least 240px and to at most `paneWidth - 400`, so the transcript keeps 400px.

### `src/renderer/src/components/right-panel.tsx` (kernel UI)

- `RightPanel({ paneId, panels })`, exported through `@dia/renderer-plugin`. It records whether `panels` is empty for the header toggle, and records `false` when it unmounts. While the tab's region is open and `panels` is not empty it renders an `aside` named by the shown panel's title: a 1px left border, no shadow, the stored width capped by `max-width: calc(100% - 400px)` so a narrowing window shrinks the region before the transcript; a 40px header with the panel title (one panel) or a `Select` switcher labelled `Panel` (two or more), over a hairline divider; the body inside a `PluginBoundary` that scrolls.
- The left edge is a focusable `separator` (`Resize panel`): dragging it left widens the region; `ArrowLeft` and `ArrowRight` step 16px; `Home` or a double-click returns to 400px.
- `RightPanelToggle({ paneId })` is kernel UI in `TabHeader`, after the session rail toggle, and is not exported. It renders nothing while `panelsAvailable` is false. It listens for `Ctrl Alt B` (`event.code === 'KeyB'`, because `Alt` changes `event.key` on macOS) only while it renders.

### Chat plugin

`plugins/dia-chat/pane.tsx` lays the pane out as a flex row: the transcript area (`flex-1`, holding the scroller, composer and session rail) and then `RightPanel` with `useList(PanelsSlot)`. An archived tab shows no region. The scroller measures the transcript area only, so `useRailLayout` decides whether the rail cards fit beside the column in the space the panel leaves.

### Example plugin

`plugins/dia-example` adds one panel, `Example`, whose body names the pane id.

## Rejected

| Option | Why not |
|---|---|
| A kernel `addPanel(ctx, panel)` and a new ADR amending ADR-0031 and ADR-0040 (the issue's plan) | ADR-0061 replaced kernel per-surface lists with list slots owned by the plugin that draws them. A list slot needs no kernel API and no `PLUGIN_API_VERSION` bump. |
| An `applies` hook per panel | No panel needs it yet; every panel applies to every chat tab. |
| Persisting the state per tab across restarts | The user chose session-only state. |

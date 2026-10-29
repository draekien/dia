---
status: "accepted"
date: 2026-10-29
decision-makers: William Pei
---

# Drop the inset card and make the window frame flush with 32px top rows

## Context and Problem Statement

ADR-0038 made the content a rounded card inset 8px from the window edge, and set the native window-control overlay to 48px tall so the controls centred on the card's 32px header row. The Electron 45 overlay accepts only `color`, `symbolColor` and `height` (`docs/api/structures/base-window-options.md`, lines 103-106), so each control's hover background fills the full 48px. That hover box covered the 8px margin, crossed the card's top edge and its rounded corner, and did not line up with the header row. How should the frame be laid out so the native controls line up with it?

## Decision Drivers

* The OS must still draw minimize / maximize / close, so Windows 11 Snap Layouts and the native close hover stay (ADR-0017).
* A control's hover background must not cross any edge of dia's own layout.
* The sidebar and the content must still start at the top of the window with no offset (ADR-0038).

## Considered Options

* Flush frame: no inset card; the sidebar's and the content's top rows and the overlay are all 32px tall
* Keep the inset card and draw dia's own HTML window controls
* Keep the inset card and lower it on the right below a strip that holds the native controls

## Decision Outcome

Chosen option: "Flush frame", because the user chose it (2026-10-29) over drawing custom controls, which would lose the Snap Layouts flyout (Electron exposes no `HTMAXBUTTON` hit-test; Microsoft Learn, "Apply snap layout menu").

| Rule | Value |
|---|---|
| Sidebar | `Sidebar collapsible="icon"` with the default `variant="sidebar"` (`plugins/agent-overview/agent-overview.tsx`); a 1px `border-r` separates it from the content |
| Content | `SidebarInset` with no margin, radius or shadow (`plugins/layout/layout.tsx`) |
| Overlay | `TITLE_BAR_HEIGHT` is 32 (`src/main/index.ts`); colour stays `TITLE_BAR_OVERLAY_COLOR` |
| Top rows | The sidebar's wordmark row and the content's header row are `h-8` and start at y=0; a control's hover background fills the header row and ends at the divider below it |

This supersedes ADR-0038's "Frame" and "Alignment" rows and its overlay height of 48. The rest of ADR-0038 (transparent overlay, `symbolColor` theme sync, drag rows, `--titlebar-controls-inset`, the slot table amendment) stands.

### Consequences

* Good, because each native control's hover background fills exactly the header row and meets the window's top-right corner.
* Good, because the native buttons keep Snap Layouts and the red close hover.
* Bad, because the content no longer has a resting elevation; regions are separated by borders and dividers only.
* Bad, because the close button's native red hover is a second use of red outside agent status; DESIGN.md records it as an OS exception to the One Voice Rule.

## Pros and Cons of the Options

### Flush frame

* Good, because it changes one sidebar prop and one constant.
* Bad, because it removes the inset card's visual separation from the sidebar.

### Own HTML window controls

* Good, because the hover style can match dia's ghost buttons.
* Bad, because the Snap Layouts flyout on hovering maximize needs a native `WM_NCHITTEST` → `HTMAXBUTTON` hook that Electron does not expose.

### Native controls in a strip above a lowered card

* Good, because it keeps the inset card.
* Bad, because the strip uses vertical space in the content column and brings back the header strip ADR-0038 removed.

## More Information

* Related: ADR-0017, ADR-0038.
* Electron v45 `docs/api/base-window.md`, `setTitleBarOverlay`: `height` sets the height of the title bar and the overlay.

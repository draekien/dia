---
status: "accepted; frame superseded by ADR-0039"
date: 2026-10-28
decision-makers: William Pei
---

> **The inset card frame, its alignment rule and the 48px overlay height are superseded by [ADR-0039](0039-flush-window-frame.md).**

# Draw the window controls over a transparent overlay and use the shadcn inset sidebar as the window frame

## Context and Problem Statement

ADR-0017 gave dia a 40px app header strip above the window body, with the native window-control overlay painted in the theme's background colour. Issue #52 moves the window to the shadcn inset sidebar layout (sidebar-08): the sidebar fills the left column and the content sits in a rounded card. shadcn's sidebar container is `fixed inset-y-0 h-svh`, so a header strip above it needs an offset, and the strip no longer matches the sidebar's surface. How should dia lay out the top of the window, and which part of the renderer owns the header row?

## Decision Drivers

* The sidebar and the content card must start at the top of the window with no offset.
* The window must stay draggable, and the OS must still draw minimize / maximize / close (ADR-0017).
* The header row must exist on every screen, because it is the drag area and holds the sidebar toggle.
* A plugin must still be able to replace the frame and the header (ADR-0031).

## Considered Options

* Transparent overlay; the sidebar's top row and the card's header row are the drag areas
* Keep the 40px header strip and offset the sidebar with `top-10`

## Decision Outcome

Chosen option: "Transparent overlay; the sidebar's top row and the card's header row are the drag areas", because the user chose it (2026-10-28, issue #52) after comparing it with t3code's window.

| Rule | Value |
|---|---|
| Overlay | `titleBarOverlay.color` is `#01000000` in both themes (`TITLE_BAR_OVERLAY_COLOR`, `src/main/ipc/window-ipc.ts`); height 48 |
| Theme sync | The renderer sends only `symbolColor` (`TitleBarOverlayColors`); the overlay background never changes |
| Drag areas | The agent overview's `h-8` wordmark row and the layout's `h-8` card header row carry `titlebar-drag`; `button`, `input`, `a` and `[role=separator]` inside them are `no-drag` (`index.css`) |
| Alignment | The window controls (centred at 24px) and both drag rows (8px inset + 16px) share a centre line |
| Controls inset | `--titlebar-controls-inset` keeps the card header's content clear of the window controls |
| Frame | `plugins/layout` renders `SidebarProvider`, the `sidebar` slot, and a `SidebarInset` card holding the header row (sidebar toggle, `main.header` slot) above the `main` slot |

This supersedes ADR-0017's app header strip and its background colour sync. The rest of ADR-0017 (`titleBarStyle: 'hidden'` with native overlay controls) stands.

This amends ADR-0031's slot table:

| ADR-0031 row | Now |
|---|---|
| Kernel: renders only `<AppHeader/>` and the `root` slot | Renders only the `root` slot. With `root` empty it shows a drag row with the window status and "No layout plugin is loaded" |
| `main.header` rendered by the kernel's `main` default | Rendered by `plugins/layout` in the card header row, for every view. Its kernel default (`TabHeader`) shows the breadcrumb, the transcript width control and the window status (plugin loading, update, `Ctrl K` hint); a plugin that fills `main.header` owns those items |

### Consequences

* Good, because the sidebar and the card start at the top of the window, and shadcn's `fixed h-svh` sidebar container needs no offset.
* Good, because the overlay needs no colour per theme, so the renderer no longer reads the background token for it.
* Bad, because a plugin that fills `main.header` removes the window status unless it renders its own.
* Bad, because macOS is not handled: its traffic lights would sit over the sidebar's wordmark row. dia targets Windows and Linux, as in ADR-0017.

## Pros and Cons of the Options

### Transparent overlay; drag rows in the sidebar and the card

* Good, because there is no separate strip, and no offset.
* Bad, because the drag areas are split across two plugins' rows.

### Keep the 40px strip with a `top-10` offset

* Good, because it keeps ADR-0017 unchanged.
* Bad, because shadcn's sidebar container must be offset by hand, and the strip does not match the sidebar's surface.

## More Information

* Design: `docs/designs/settings-dialog-and-inset-sidebar.md`.
* Electron v45 `docs/tutorial/custom-title-bar.md:157-158`: overlay colours accept `#RRGGBBAA` and support transparency. t3code uses `#01000000` because `#00000000` does not work correctly on Linux (`.repos/t3code/apps/desktop/src/window/DesktopWindow.ts:56`).
* Related: ADR-0005, ADR-0017, ADR-0031.

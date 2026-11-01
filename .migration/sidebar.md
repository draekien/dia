# sidebar

2026-11-01, transformation engine (legacy `new-york`), five `Slot` users moved to `useRender` + `mergeProps`.

## Changed

* `src/renderer/src/components/ui/sidebar.tsx`: `SidebarGroupLabel`, `SidebarGroupAction`, `SidebarMenuButton`, `SidebarMenuAction`, `SidebarMenuSubButton` take `render` instead of `asChild`. Their `data-slot` / `data-sidebar` / `data-size` / `data-active` attributes are passed as props, not `useRender` state: state would drop `data-active="false"` and write `data-active=""` for true, which the `data-[active=true]:` selectors do not match. Menu-open styling `data-[state=open]:*` → `data-popup-open:*` on `SidebarMenuButton` and `SidebarMenuAction`. The tooltip trigger inside `SidebarMenuButton` uses `render={button}`.
* `plugins/agent-overview/agent-overview.tsx:146` (`MetaGroup`): `SidebarMenuButton asChild` over a `<div>` → `render={<div />}`.
* `plugins/agent-overview/agent-row.tsx:139` (rename mode): `asChild` over `<div data-nav>` → `render={<div data-nav={…} />}`.
* `plugins/agent-overview/project-group.tsx:105`: `SidebarGroupLabel asChild` over the sortable `<button>` → `render={<button …>…</button>}`, nested inside `ContextMenuTrigger render`. Base UI merges the render element's own ref at each level (`useMergedRefs` in `internals/useRenderElement.js`), so `setActivatorNodeRef` still reaches the button.
* `docs/designs/settings-dialog-and-inset-sidebar.md:150`: wording updated from `asChild` to `render`.
* Leftover scan: clean.

## Left alone

* `data-state="expanded" | "collapsed"` and the `[data-state=collapsed]` selectors: the sidebar's own state, not Radix.

## Behavior changes

* None.

## Verify by hand

* Drag a project header to reorder projects: the drag starts from the header.
* Collapse the sidebar (Ctrl P from the collapsed view expands it again, per the existing test): agent dots show tooltips on the right.
* The selected agent row keeps its highlighted background (`data-active="true"`).

# Renderer

## Design Context

`PRODUCT.md` (product context) and `DESIGN.md` (design system) at the repo root apply to all UI/UX work. Read both before starting it.

### Mandatory skill invocation

These triggers extend the table in the root `CLAUDE.md` and follow its rule.

| Trigger | Required skill |
| --- | --- |
| Any UI/UX work — new components, layout, styling, interaction | `impeccable` |
| Adding, modifying, or composing any shadcn/ui component | `shadcn` |

## Styling

- Scrollbars are styled for every element by the `::-webkit-scrollbar` rules in `@layer base` of `src/index.css`. Do not set `scrollbar-width` or `scrollbar-color` on an element, or use a utility that sets them (shadcn's `scrollbar-thin`): Chromium then draws its native scrollbar on that element. To hide a scrollbar, use `scrollbar-none`.
- Use `class-variance-authority` (`cva`) for any component with style variants driven by props or state (e.g. a status/tag union, `variant`/`size` props) — see `components/ui/button.tsx` and `components/status-indicator.tsx`. Don't hand-roll a lookup object plus template-literal class strings for this.

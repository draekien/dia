# Renderer

## Design Context

`PRODUCT.md` and `DESIGN.md` at the repo root carry dia's design system — read before any UI/UX work. Register: **product** (design serves the tool, a single-user pane workspace). North star: **"The Control Room"** — calm, glanceable status across up to six concurrent panes, with amber/red/green pulse indicators as the app's one deliberate loud signal. Key principles: glanceability over detail, one voice for attention (pulse only), calm density, native-not-decorative craft, fast under real use. `DESIGN.md` is currently a seed (no code yet); re-run `/impeccable document` once components exist to capture real tokens.

### Mandatory skill invocation

These are BLOCKING REQUIREMENTS, not suggestions — see the root `CLAUDE.md` for the full table this extends. Before writing or editing any code matching a trigger below, invoke the listed skill via the Skill tool FIRST.

| Trigger | Required skill |
| --- | --- |
| Any UI/UX work — new components, layout, styling, interaction | `impeccable` (craft) |
| Adding, modifying, or composing any shadcn/ui component | `shadcn` |

## Styling

- Use `class-variance-authority` (`cva`) for any component with style variants driven by props or state (e.g. a status/tag union, `variant`/`size` props) — see `components/ui/button.tsx` and `components/pulse-indicator.tsx`. Don't hand-roll a lookup object plus template-literal class strings for this.

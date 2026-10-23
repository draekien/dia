<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->

---
name: dia
description: A desktop app that runs Claude Agent SDK agents for many projects in the background, notifies the user when an agent needs input, and shows what every agent is doing.
---

# Design System: dia

## 1. Overview

**Creative North Star: "The Dispatch Desk"**

dia is a polished native desktop app in the lineage of Linear, Arc, and Raycast: crisp, cool-neutral surfaces; deliberate, sparing color; motion that responds to what the user just did rather than performing for its own sake. The user sends agents out to work and does not watch them. The UI's first job is to show, in one list, which agents need the user and what the others are doing, and then to get out of the way: one agent's tab fills the window at a time, and the rest keep working out of view.

This system explicitly rejects two adjacent aesthetics: the generic AI-chat-SaaS look (gradient hero treatments, bubbly chat-marketing polish, anything that reads as a hosted product's landing page) and the raw terminal-multiplexer look (bare ASCII borders, zero-chrome, tmux-default starkness). dia is a native app that happens to run agent sessions — not a wrapped terminal, and not a product being sold.

**Key Characteristics:**
- Cool-neutral, full-palette surface with each color role used deliberately
- Sans + mono pairing: sans for chrome and UI copy, mono for session/code content
- Status indicators (amber/red/green) are the one place the UI raises its voice
- Responsive, non-choreographed motion: transitions confirm actions, they don't perform

## 2. Colors

A full-palette, cool-neutral strategy: several named roles, each with one deliberate job, so a scan down the agent overview reads every agent's status correctly without any of them shouting.

### Primary
- **[to be resolved during implementation]** — a single restrained accent (deep blue/indigo family) for the selected tab, the selected overview row, primary actions, and focus rings. Used sparingly; never for status.

### Secondary
- **[to be resolved during implementation]** — a secondary role reserved for structural chrome (the tab strip, the overview's dividers, panel borders) distinct from the primary accent.

### Tertiary
- **[to be resolved during implementation]** — reserved exclusively for the three agent status states: amber (needs input: a permission request or a question), red (failed), green (finished). This is the system's only "loud" color use.

### Neutral
- **[to be resolved during implementation]** — cool-toned (graphite/slate) background, surface, text, and border ramp. Backgrounds sit at the dark-to-light ends depending on OS light/dark mode; body text and dividers are drawn from the same cool ramp, never warm-tinted.

### Named Rules
**The One Voice Rule.** Amber/red/green are reserved exclusively for agent status, wherever it appears: a tab, an overview row, the tray icon. No other UI element — button, badge, link — may reuse them, or the status loses its meaning as the app's one urgent signal.

## 3. Typography

**Display/UI Font:** Geist Sans (`Geist Variable`, self-hosted via `@fontsource-variable/geist`) — a technical/geometric sans for chrome, labels, and UI copy. Wired as `--font-sans` in `src/renderer/src/index.css`.
**Mono Font:** Geist Mono (`Geist Mono Variable`, self-hosted via `@fontsource-variable/geist-mono`) — for code, file paths, tool names, and other literal agent output. Wired as `--font-mono`. Paired with Geist Sans as one metric-matched superfamily, so sans and mono read as one system.

**Character:** Crisp and native-feeling, closer to an IDE or terminal-adjacent tool than a marketing document. The sans carries structure and labels; the mono carries literal/technical content, so the two are never used interchangeably for the same kind of information.

### Hierarchy

A fixed `rem` scale (Tailwind v4 defaults, product-appropriate ~1.125–1.2 ratio); no fluid `clamp()`. Hierarchy is carried by size **and** weight together, not size alone.

- **Display** — `text-xl`+ / semibold: reserved for empty-state or first-run moments only; dia has no marketing headlines.
- **Heading** — `text-base` (1rem) / semibold: card, section, and form titles (e.g. "Permission requested", "New agent"). This is the top of the shipped chrome hierarchy.
- **Body** — `text-sm` (0.875rem): UI copy and chrome, and agent **prose** message bodies; all sans. Weight `font-medium` marks a label within body-size text.
- **Caption** — `text-xs` (0.75rem): status labels, overview activity lines, metadata, field hints, tool-event rows, path chips.

### Named Rules
**The Content-Is-Mono Rule.** The agent's *literal output* — code, file paths, tool names, command strings, and other verbatim snippets — renders in the mono family. Everything else, including the agent's *prose* (paragraphs, lists, and headings inside a Markdown message) and all of dia's own chrome (buttons, labels, dialogs), renders in the sans family. The two are never mixed within one span of text: mono is a signal that "this is a literal string," so widening it to whole prose bodies would drain that signal. An overview activity line follows the same rule: a `TodoWrite` item is sans, a tool call such as `Edit src/main/index.ts` is mono.

## 4. Elevation

Responsive motion pairs with a mostly-flat surface: the tab strip, the agent overview and the visible tab's content are separated by borders/dividers rather than drop shadows in their resting state. Elevation (a subtle lift) is reserved as a state response — an open dialog, a permission prompt, a command palette — never as ambient decoration.

### Shadow Vocabulary
- **Dialog lift** (`[value to be resolved]`): applied only to modal/dialog and overlay surfaces, to distinguish "what needs my answer now" from the flat resting surface.

### Named Rules
**The Flat-Surface Rule.** At rest, the tab strip, the overview and the tab content sit on the same flat plane, separated only by dividers. Elevation appears only in direct response to an open dialog or overlay — never to decorate a resting surface.

## 5. Components

### Buttons
- **Shape:** [radius to be resolved at implementation] — small, consistent with a native-app control, not sharp/terminal square and not pill-rounded/marketing-soft.
- **Primary:** primary accent background, used only for the single clear primary action in a given dialog (e.g. "Approve" in a permission prompt).
- **Hover / Focus:** subtle background shift + visible focus ring; no scale/bounce.
- **Secondary / Ghost:** neutral-bordered or text-only, for all non-primary actions (the majority of buttons in a dense UI like this).

### Status Indicator (signature component)
The one component the whole system is built around. A small dot on an agent's tab, its overview row, and the tray icon: amber pulsing (needs input), red pulsing (failed), green steady (finished, until the user opens the tab). Only amber and red pulse, because only those states block on the user and also raise an OS notification. Motion is a gentle opacity/scale pulse that stops under reduced-motion settings, leaving the color. This is the system's single sanctioned "loud" element per the One Voice Rule.

### Agent Overview
- **Purpose:** every agent in every project in one list, grouped by project, so the user knows which agents need them without opening a tab.
- **Row:** status indicator, tab name, and one caption-size activity line (the in-progress `TodoWrite` item, else the last tool call).
- **Order:** agents that need input or have failed sort to the top of their project group.
- **Selection:** selecting a row shows that agent's tab; the selected row uses the primary accent, never a status color.

### Tabs
- **One visible:** exactly one agent's tab fills the content area. There are no split panes.
- **Tab strip:** each tab shows the status indicator and the tab name; tabs belong to the selected project.
- **Background tabs:** tabs that are not visible keep running and show their status in the tab strip and the overview only.

### Inputs / Fields
- **Style:** [to be resolved] — flat, bordered, neutral background.
- **Focus:** border shift to primary accent + focus ring, matching button focus treatment.
- **Error / Disabled:** error state may borrow the tertiary error red, muted rather than full pulse-intensity, to stay distinct from the status indicator's meaning.

### Navigation
The agent overview and the tab strip are the primary navigation. Any command palette or agent switcher reads as an overlay (Raycast-style), not a further persistent chrome element.

## 6. Do's and Don'ts

### Do:
- **Do** keep color roles deliberate: primary for action/selection, secondary for structure, tertiary reserved for agent status only, per the One Voice Rule.
- **Do** use mono for all literal agent/session content and sans for all dia chrome, per the Content-Is-Mono Rule.
- **Do** keep resting surfaces flat, reserving elevation for dialogs and overlays, per the Flat-Surface Rule.
- **Do** make motion responsive to real actions (tab switch, row selection, status change) — confirm, don't choreograph.

### Don't:
- **Don't** build a generic AI-chat-SaaS look — no gradient hero treatments, no bubble-chat marketing polish, nothing that reads as a hosted product's landing page.
- **Don't** default to a raw terminal-multiplexer aesthetic — no bare ASCII-art borders, no zero-chrome-for-its-own-sake tmux-default look.
- **Don't** reuse amber/red/green outside the status indicator; that overloads the app's one urgent signal.
- **Don't** pulse for a finished agent; a finished agent does not need the user, and a pulse there makes the needs-input pulse easier to ignore.

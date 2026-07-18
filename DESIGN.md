<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->

---
name: dia
description: A personal, multi-pane desktop workspace for running parallel Claude Agent SDK sessions.
---

# Design System: dia

## 1. Overview

**Creative North Star: "The Control Room"**

dia is a polished native desktop app in the lineage of Linear, Arc, and Raycast: crisp, cool-neutral surfaces; deliberate, sparing color; motion that responds to what the user just did rather than performing for its own sake. It exists to hold up to six independent, live agent sessions at once, so the UI's first job is calm legibility under real multitasking load — a control room, not a chatroom.

This system explicitly rejects two adjacent aesthetics: the generic AI-chat-SaaS look (gradient hero treatments, bubbly chat-marketing polish, anything that reads as a hosted product's landing page) and the raw terminal-multiplexer look (bare ASCII borders, zero-chrome, tmux-default starkness). dia is a native app that happens to run agent sessions — not a wrapped terminal, and not a product being sold.

**Key Characteristics:**
- Cool-neutral, full-palette surface with each color role used deliberately
- Sans + mono pairing: sans for chrome and UI copy, mono for session/code content
- Pulse indicators (amber/red/green) are the one place the UI raises its voice
- Responsive, non-choreographed motion: transitions confirm actions, they don't perform

## 2. Colors

A full-palette, cool-neutral strategy: several named roles, each with one deliberate job, so a glance across six panes reads status correctly without any of them shouting.

### Primary
- **[to be resolved during implementation]** — a single restrained accent (deep blue/indigo family) for active-pane focus rings, primary actions, and selection states. Used sparingly; never for status.

### Secondary
- **[to be resolved during implementation]** — a secondary role reserved for structural chrome (pane borders, dividers, split handles) distinct from the primary accent.

### Tertiary
- **[to be resolved during implementation]** — reserved exclusively for the three pulse states: amber (awaiting permission), red (errored), green (completed). This is the system's only "loud" color use.

### Neutral
- **[to be resolved during implementation]** — cool-toned (graphite/slate) background, surface, text, and border ramp. Backgrounds sit at the dark-to-light ends depending on OS light/dark mode; body text and dividers are drawn from the same cool ramp, never warm-tinted.

### Named Rules
**The One Voice Rule.** Amber/red/green pulse colors are reserved exclusively for pane attention state. No other UI element — button, badge, link — may reuse them, or the pulse loses its meaning as the app's one urgent signal.

## 3. Typography

**Display/UI Font:** Geist Sans (`Geist Variable`, self-hosted via `@fontsource-variable/geist`) — a technical/geometric sans for chrome, labels, and UI copy. Wired as `--font-sans` in `src/renderer/src/index.css`.
**Mono Font:** Geist Mono (`Geist Mono Variable`, self-hosted via `@fontsource-variable/geist-mono`) — for code, file paths, tool names, and other literal agent output. Wired as `--font-mono`. Paired with Geist Sans as one metric-matched superfamily, so sans and mono read as one system.

**Character:** Crisp and native-feeling, closer to an IDE or terminal-adjacent tool than a marketing document. The sans carries structure and labels; the mono carries literal/technical content, so the two are never used interchangeably for the same kind of information.

### Hierarchy

A fixed `rem` scale (Tailwind v4 defaults, product-appropriate ~1.125–1.2 ratio); no fluid `clamp()`. Hierarchy is carried by size **and** weight together, not size alone.

- **Display** — `text-xl`+ / semibold: reserved for empty-state or first-run moments only; dia has no marketing headlines.
- **Heading** — `text-base` (1rem) / semibold: card, section, and form titles (e.g. "Permission requested", "New pane"). This is the top of the shipped chrome hierarchy.
- **Body** — `text-sm` (0.875rem): UI copy and chrome, and agent **prose** message bodies; all sans. Weight `font-medium` marks a label within body-size text.
- **Caption** — `text-xs` (0.75rem): status labels, metadata, field hints, tool-event rows, path chips.

### Named Rules
**The Content-Is-Mono Rule.** The agent's *literal output* — code, file paths, tool names, command strings, and other verbatim snippets — renders in the mono family. Everything else, including the agent's *prose* (paragraphs, lists, and headings inside a Markdown message) and all of dia's own chrome (buttons, labels, dialogs), renders in the sans family. The two are never mixed within one span of text: mono is a signal that "this is a literal string," so widening it to whole prose bodies would drain that signal.

## 4. Elevation

Responsive motion pairs with a mostly-flat surface: panes are separated by borders/dividers rather than drop shadows in their resting state, since six adjacent panes with individual shadows would read as visual noise. Elevation (a subtle lift) is reserved as a state response — the focused pane, an open dialog, a permission prompt — never as ambient decoration.

### Shadow Vocabulary
- **Focus lift** (`[value to be resolved]`): applied only to the currently-focused pane and modal/dialog surfaces, to distinguish "what has my attention" from the flat resting grid.

### Named Rules
**The Flat-Grid Rule.** At rest, all panes sit on the same flat plane, separated only by dividers. Elevation appears only in direct response to focus or an open dialog — never to decorate an idle pane.

## 5. Components

### Buttons
- **Shape:** [radius to be resolved at implementation] — small, consistent with a native-app control, not sharp/terminal square and not pill-rounded/marketing-soft.
- **Primary:** primary accent background, used only for the single clear primary action in a given dialog (e.g. "Approve" in a permission prompt).
- **Hover / Focus:** subtle background shift + visible focus ring; no scale/bounce.
- **Secondary / Ghost:** neutral-bordered or text-only, for all non-primary actions (the majority of buttons in a dense UI like this).

### Pulse Indicator (signature component)
The one component the whole system is built around. A small, animated dot or ring on a pane's tab/border: amber pulsing (awaiting permission), red pulsing (errored), green (completed, briefly, then settles to idle). Motion is a gentle opacity/scale pulse — deliberate but not distracting from adjacent panes. This is the system's single sanctioned "loud" element per the One Voice Rule.

### Panes / Containers
- **Corner Style:** [to be resolved] — flat or minimally rounded, consistent with a native window-manager surface, not a card.
- **Background:** neutral surface tone; focused pane distinguished via elevation + border, not a background color change.
- **Shadow Strategy:** see Elevation — flat at rest, lift only on focus.
- **Border:** thin divider between adjacent panes, from the secondary/structural role.
- **Internal Padding:** [scale to be resolved].

### Inputs / Fields
- **Style:** [to be resolved] — flat, bordered, neutral background.
- **Focus:** border shift to primary accent + focus ring, matching button focus treatment.
- **Error / Disabled:** error state may borrow the tertiary error red, muted rather than full pulse-intensity, to stay distinct from the pulse indicator's meaning.

### Navigation
No traditional top/side nav; the pane grid itself is the primary surface. Any command palette or session switcher should read as an overlay (Raycast-style), not a persistent chrome element competing with pane content.

## 6. Do's and Don'ts

### Do:
- **Do** keep color roles deliberate: primary for action/focus, secondary for structure, tertiary reserved for pulse state only, per the One Voice Rule.
- **Do** use mono for all literal agent/session content and sans for all dia chrome, per the Content-Is-Mono Rule.
- **Do** keep panes flat at rest, reserving elevation for focus and dialogs, per the Flat-Grid Rule.
- **Do** make motion responsive to real actions (focus, split, resize, pulse start) — confirm, don't choreograph.

### Don't:
- **Don't** build a generic AI-chat-SaaS look — no gradient hero treatments, no bubble-chat marketing polish, nothing that reads as a hosted product's landing page.
- **Don't** default to a raw terminal-multiplexer aesthetic — no bare ASCII-art borders, no zero-chrome-for-its-own-sake tmux-default look.
- **Don't** reuse amber/red/green outside the pulse indicator; that overloads the app's one urgent signal.
- **Don't** add drop shadows to idle, unfocused panes — that's decorative noise at exactly the moment (many panes open) the UI most needs to stay calm.

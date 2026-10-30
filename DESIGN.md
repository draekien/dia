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
- **[to be resolved during implementation]** — a secondary role reserved for structural chrome (the sidebar's project group dividers, panel borders) distinct from the primary accent.

### Tertiary
- **[to be resolved during implementation]** — reserved exclusively for the three agent status states: amber (needs input: a permission request or a question), red (failed), green (finished). This is the system's only "loud" color use.

### Neutral
- **[to be resolved during implementation]** — cool-toned (graphite/slate) background, surface, text, and border ramp. Backgrounds sit at the dark-to-light ends depending on OS light/dark mode; body text and dividers are drawn from the same cool ramp, never warm-tinted.

### Named Rules
**The One Voice Rule.** Amber/red/green are reserved exclusively for agent status, wherever it appears: an overview row, the collapsed rail. No other UI element — button, badge, link — may reuse them, or the status loses its meaning as the app's one urgent signal. The one exception is the OS-drawn close button's red hover, which dia does not style (ADR-0039).

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

The window has one resting level. The sidebar and the content area both fill the window from its top edge with no title bar strip; a 1px border separates them (ADR-0039). Their 32px top rows share one line with the native window controls, whose hover background fills the content's top row. Any elevation is a state response — an open dialog, a permission prompt, a command palette — never ambient decoration.

### Shadow Vocabulary
- **Dialog lift** (`[value to be resolved]`): applied only to modal/dialog and overlay surfaces, to distinguish "what needs my answer now" from the flat resting surface.

### Named Rules
**The Flat Frame Rule.** At rest there is one level. The sidebar and the content area, and the regions inside them, are separated by borders and dividers, not shadows. Elevation appears only in direct response to an open dialog or overlay.

## 5. Components

### Buttons
- **Shape:** [radius to be resolved at implementation] — small, consistent with a native-app control, not sharp/terminal square and not pill-rounded/marketing-soft.
- **Primary:** primary accent background, used only for the single clear primary action in a given dialog (e.g. "Approve" in a permission prompt).
- **Hover / Focus:** subtle background shift + visible focus ring; no scale/bounce.
- **Secondary / Ghost:** neutral-bordered or text-only, for all non-primary actions (the majority of buttons in a dense UI like this).

### Status Indicator (signature component)
The one component the whole system is built around. A small dot on an agent's overview row and its place in the collapsed rail, in five states: amber with a pulsing ring (needs input), red with a pulsing ring (failed), a neutral dot with a slow opacity pulse (working), green steady (finished, until the user shows the tab), and a hollow neutral ring (idle). Only amber and red get the ring, because only those states block on the user and also raise an OS notification; the working pulse is slow and neutral so it reads as activity, not as a call for attention. All motion stops under reduced-motion settings, leaving the color. A legend or filter sample renders the dot still (`still`), because it stands for a status rather than reporting one. This is the system's single sanctioned "loud" element per the One Voice Rule.

### Agent Overview
- **Purpose:** the left sidebar. It lists every agent in every project, grouped by project, so the user knows which agents need them without opening a tab. It is also the only way to switch tabs: there is no tab strip.
- **Header:** a search input (`Ctrl P` focuses it; `↓` moves into the list; `Enter` with a query shows the first matching agent; `Esc` clears it), a filter icon button whose popover holds one checkbox per status with its count, "Show archived agents", "Hide projects with no matches" and "Clear filters" (a dot on the button marks an active filter), and an add-project icon button that opens the directory picker.
- **Meta group:** pinned above all projects, with a count of open proposals, and hidden while a search or filter applies. A meta branch waiting for approval is a row in this group.
- **Row:** status indicator, tab name, and one caption-size second line: the reason for an agent that needs input or failed, else the activity line (the in-progress `TodoWrite` item in sans, else the last tool call in mono). `F2` or the row menu renames the agent in place.
- **Order:** project order is fixed and set by the user by dragging a project header, or from the keyboard (`Space` lifts, `↑`/`↓` move, `Space` drops, `Esc` cancels, with the new position announced); a status change never moves a project group. Inside a group, agents sort needs input, failed, working, finished, idle, then by creation.
- **Overflow:** project groups collapse. A collapsed group's header shows its most urgent status and a count of its agents; while a search or filter applies, every group is open and counts read `n of total`. Groups are separated by a hairline divider. `↑`/`↓` move between headers and rows, `→`/`←` open and close a group, and the list has one tab stop.
- **Project menu:** New agent, Reveal in Explorer, Remove project. Removing a project opens a dialog that lists every agent, worktree and transcript to be removed, enables "Remove" once the project name is typed, and then shows each item's progress.
- **Archived:** while "Show archived agents" is on, archived agents follow an `Archived · n` caption at the bottom of their project group.
- **Collapsed rail:** `Ctrl B` or the sidebar toggle in the content header collapses the sidebar to a narrow rail: the Meta marker first, then one status indicator per agent, with a hairline between projects and a tooltip naming project, agent, status and activity.
- **Width:** dragging the sidebar's edge resizes it between 14rem and 32rem (default 18rem); double-clicking the edge resets it, and with the edge focused `←`/`→` resize and `Home` resets. A click on the edge does nothing.
- **Top row:** the `dia` wordmark row is a window drag area, level with the window controls.
- **Selection:** selecting a row shows that agent's tab; the selected row uses a primary-tinted fill and a medium-weight name, never a status color and never an edge stripe.

### Tabs
- **One visible:** exactly one agent's tab fills the content area. There are no split panes.
- **Selecting:** a tab is selected from its sidebar row. The content area's header row holds the sidebar toggle, a breadcrumb `project › agent`, the worktree branch when there is one, the transcript width control, and the window status (plugin loading, update, `Ctrl K` hint). The header row is a window drag area; its content stays clear of the window controls. A divider separates it from the transcript.
- **Transcript width:** the transcript and composer sit in one centred column, capped at one of three widths (Narrow, Default, Wide) chosen app-wide from the content header or Settings › General; a narrower content area fills the column.
- **Background tabs:** tabs that are not visible keep running and show their status in the sidebar and the collapsed rail only.
- **Messages:** the user's messages sit in a tinted bubble on the right. The agent's text renders as plain Markdown on the left, with no bubble.

### Turn steps
- **Shape:** a native `<details>` in the assistant turn, collapsed by default. Each run of consecutive thinking and tool steps forms one section; the agent's text always stays visible between sections. Expanding a section shows its thinking and tool rows, indented `pl-6` so each row's icon lines up under the summary text. A re-render keeps the open state.
- **Finished summary:** a chevron that turns 90° when open, then `N steps · 12s` in caption size, muted. When tool calls failed it reads `N steps · 1 failed · 12s`, with the failed count in foreground text, not red. The duration runs from the section's first part to the text after it; it is left out when unknown. Durations of a minute or more read `1m 5s`.
- **Running summary:** the turn's last section shows the activity line in place of the count: a neutral pulsing dot, the latest step (tool name and target in mono, or `Thinking` in sans) or the turn's named state, and the time since the section's first part. It replaces the separate activity line; the dot stops under reduced motion and the label is `aria-live="polite"`. When the turn stalls, `Interrupt & retry` and `Resend` show on their own row under the summary, never inside `<summary>`.
- **Tool rows:** a check when the call succeeded, an `X` in foreground text when it failed (screen readers hear "failed"). A row with output is itself a disclosure and shows a `muted/60` background on hover.
- **Focus:** every `<summary>` in the transcript shows the app ring (`focus-visible:ring-[3px] ring-ring/50`), never the browser's default outline.
- **Not collapsed:** notices, errors, permission, question and plan cards stay outside sections. A turn restored from history, and a turn with no steps, have no section.

### Inputs / Fields
- **Style:** [to be resolved] — flat, bordered, neutral background.
- **Focus:** border shift to primary accent + focus ring, matching button focus treatment.
- **Error / Disabled:** error state may borrow the tertiary error red, muted rather than full pulse-intensity, to stay distinct from the status indicator's meaning.

### Navigation
The sidebar is the primary navigation. Any command palette or agent switcher reads as an overlay (Raycast-style), not a further persistent chrome element. Every setting lives in one Settings dialog (General · Adapters · Plugins in a left nav, a breadcrumb over the page); the command palette has one Settings item, and its search also lists each Settings page.

## 6. Do's and Don'ts

### Do:
- **Do** keep color roles deliberate: primary for action/selection, secondary for structure, tertiary reserved for agent status only, per the One Voice Rule.
- **Do** use mono for all literal agent/session content and sans for all dia chrome, per the Content-Is-Mono Rule.
- **Do** keep to the one resting level, reserving elevation for dialogs and overlays, per the Flat Frame Rule.
- **Do** make motion responsive to real actions (tab switch, row selection, status change) — confirm, don't choreograph.

### Don't:
- **Don't** build a generic AI-chat-SaaS look — no gradient hero treatments, no bubble-chat marketing polish, nothing that reads as a hosted product's landing page.
- **Don't** default to a raw terminal-multiplexer aesthetic — no bare ASCII-art borders, no zero-chrome-for-its-own-sake tmux-default look.
- **Don't** reuse amber/red/green outside the status indicator; that overloads the app's one urgent signal.
- **Don't** pulse for a finished agent; a finished agent does not need the user, and a pulse there makes the needs-input pulse easier to ignore.

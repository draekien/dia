---
name: dia
description: A desktop app that runs Claude Agent SDK agents for many projects in the background, notifies the user when an agent needs input, and shows what every agent is doing.
colors:
  signal-indigo: "oklch(0.52 0.18 265)"
  indigo-ink: "oklch(0.99 0.01 265)"
  cool-ground: "oklch(0.97 0.004 255)"
  raised-sheet: "oklch(0.995 0.001 255)"
  slate-ink: "oklch(0.25 0.015 255)"
  muted-slate: "oklch(0.5 0.02 255)"
  hairline: "oklch(0.9 0.006 255)"
  quiet-fill: "oklch(0.93 0.008 255)"
  error-red: "oklch(0.52 0.2 25)"
  needs-input-amber: "oklch(0.7 0.15 70)"
  failed-red: "oklch(0.55 0.22 25)"
  finished-green: "oklch(0.55 0.15 145)"
typography:
  display:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
  heading:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
  title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
  body:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
  micro:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  checkbox: "5px"
  sm: "6px"
  floor: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  card: "18px"
  panel: "34px"
  full: "9999px"
spacing:
  run: "0px"
  related: "8px"
  row-inset: "8px"
  hit-min: "24px"
  section: "24px"
  row: "44px"
  hit-coarse: "44px"
components:
  button-primary:
    backgroundColor: "{colors.signal-indigo}"
    textColor: "{colors.indigo-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.cool-ground}"
    textColor: "{colors.slate-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.slate-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.slate-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.slate-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.floor}"
    padding: "0 {spacing.row-inset}"
    height: "{spacing.row}"
  status-dot:
    textColor: "{colors.muted-slate}"
    rounded: "{rounded.full}"
    size: "10px"
  entity-media:
    backgroundColor: "{colors.raised-sheet}"
    textColor: "{colors.muted-slate}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    size: "24px"
  tooltip:
    backgroundColor: "{colors.slate-ink}"
    textColor: "{colors.cool-ground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
---

# Design System: dia

## Overview

**Creative North Star: "The Dispatch Desk"**

dia is a polished native desktop app in the lineage of Linear, Arc, and Raycast: crisp, cool-neutral surfaces; deliberate, sparing color; motion that responds to what the user just did rather than performing for its own sake. The user sends agents out to work and does not watch them. The UI's first job is to show, in one list, which agents need the user and what the others are doing, and then to get out of the way: one agent's tab fills the window at a time, and the rest keep working out of view.

The colour palette is named **Control Room**: many status lights on a quiet cool-neutral ground, with one operator watching them. Density is that of a desktop tool: 14px body text, 44px record rows, hairline dividers instead of cards, and one accent.

This system explicitly rejects two adjacent aesthetics: the generic AI-chat-SaaS look (gradient hero treatments, bubbly chat-marketing polish, anything that reads as a hosted product's landing page) and the raw terminal-multiplexer look (bare ASCII borders, zero-chrome, tmux-default starkness). dia is a native app that happens to run agent sessions — not a wrapped terminal, and not a product being sold.

**Key Characteristics:**
- Cool-neutral Control Room palette, in a light and a dark theme, with each color role used deliberately
- Sans + mono pairing: sans for chrome and UI copy, mono for session/code content
- Amber, red and green carry severity only: amber for a warning or alert, red for an error, green for a finished agent
- Records are drawn with the draekien/design-system components (`List`, `Status`, `Entity`, `Figure`, `RelativeTime`) on dia's own tokens
- Responsive, non-choreographed motion: transitions confirm actions, they don't perform

## Colors

The Control Room palette: a cool-neutral ramp (hue 255) with one indigo accent and three severity colours. The frontmatter holds the light theme; the `.dark` block in `src/renderer/src/index.css` redefines every role at the dark end of the same ramp, and `.impeccable/design.json` lists both values.

### Primary
- **Signal Indigo** (`--primary`): the selected sidebar row and sub-navigation entry (as a `bg-primary/10` tint), the one primary action in a dialog, the composer's send button when it can send, links, and every focus ring (`--ring` has the same value). Never used for status.
- **Indigo Ink** (`--primary-ink`): text and icons on a Signal Indigo fill.

### Tertiary
- **Needs-input Amber** (`--pulse-amber`): an agent that needs input, a context window near its auto-compact threshold, and other warnings.
- **Failed Red** (`--pulse-red`): a failed agent's status dot.
- **Error Red** (`--error`): error text, a failed plugin's status dot, destructive buttons, invalid fields, and the error toast icon.
- **Finished Green** (`--pulse-green`): a finished agent, until the user shows its tab.

### Neutral
- **Cool Ground** (`--background`): the window background and the content area.
- **Raised Sheet** (`--surface`): the sidebar, cards, popovers, the session rail cards and avatar backgrounds.
- **Slate Ink** (`--ink`): body text and icons.
- **Muted Slate** (`--ink-muted`): captions, metadata, hints, the working and idle status dots.
- **Hairline** (`--border`): 1px dividers, field borders and the scrollbar thumb.
- **Quiet Fill** (`--secondary`): hover fills, the neutral `secondary` button and the code surface.

Charts use `--chart-1` to `--chart-5`, and code highlighting uses the `--syntax-*` set; neither set is used for chrome.

### Named Rules
**The One Voice Rule.** Amber marks every warning and alert. Red marks every error. Green marks a finished agent. No element uses these colours for decoration or emphasis: diff added and removed lines are neither warnings nor errors, so they do not use them. Amber and red pulse only on the status indicator. The OS-drawn close button's red hover is not dia's and does not follow this rule (ADR-0039).

**The No Middle Dot Rule.** Text dia writes never uses the middle dot (U+00B7) as a separator. Use layout spacing, a line break, a comma or a sentence instead: `3 steps, Bash failed, 12s`, not the same parts joined by middle dots. Data from elsewhere shown verbatim, such as a skill's `argumentHint`, keeps its own characters.

## Typography

**Display/UI Font:** Geist Sans (`Geist Variable`, self-hosted via `@fontsource-variable/geist`) — a technical/geometric sans for chrome, labels, and UI copy. Wired as `--font-sans` in `src/renderer/src/index.css`.
**Mono Font:** Geist Mono (`Geist Mono Variable`, self-hosted via `@fontsource-variable/geist-mono`) — for code, file paths, tool names, and other literal agent output. Wired as `--font-mono`. Paired with Geist Sans as one metric-matched superfamily, so sans and mono read as one system.

**Character:** Crisp and native-feeling, closer to an IDE or terminal-adjacent tool than a marketing document. The sans carries structure and labels; the mono carries literal/technical content, so the two are never used interchangeably for the same kind of information.

### Hierarchy

A fixed `rem` scale (Tailwind v4 defaults, product-appropriate ~1.125–1.2 ratio); no fluid `clamp()`. Hierarchy is carried by size **and** weight together, not size alone. The design-system components use the named sizes `text-title`, `text-body`, `text-label` and `text-micro`, defined in `@theme`.

- **Display** — `text-xl`+ / semibold: reserved for empty-state or first-run moments only; dia has no marketing headlines.
- **Heading** — `text-base` (1rem) / semibold: card, section, and form titles (e.g. "Permission requested", "New agent"). This is the top of the shipped chrome hierarchy.
- **Title** — `text-title` (0.875rem / semibold): a record's name in a list row.
- **Body** — `text-sm` (0.875rem): UI copy and chrome, and agent **prose** message bodies; all sans. Weight `font-medium` marks a label within body-size text.
- **Caption** — `text-xs` (0.75rem): status labels, overview activity lines, metadata, field hints, tool-event rows, path chips. `text-label` is the same size at medium weight.
- **Micro** — `text-micro` (0.625rem / medium): avatar initials only.

Numbers compared down a column use tabular figures (`tabular-nums`, which `Figure` sets).

### Named Rules
**The Content-Is-Mono Rule.** The agent's *literal output* — code, file paths, tool names, command strings, and other verbatim snippets — renders in the mono family. Everything else, including the agent's *prose* (paragraphs, lists, and headings inside a Markdown message) and all of dia's own chrome (buttons, labels, dialogs), renders in the sans family. The two are never mixed within one span of text: mono is a signal that "this is a literal string," so widening it to whole prose bodies would drain that signal. An overview activity line follows the same rule: a `TodoWrite` item is sans, a tool call such as `Edit src/main/index.ts` is mono.

## Layout

The window is a resizable sidebar (14rem to 32rem, default 18rem) beside one content area; both start at the window's top edge, and their 32px top rows share one line with the native window controls (ADR-0039). The content area shows one tab, page or Settings dialog at a time.

Spacing follows named steps from `@theme`: `run` (0) between parts that read as one, `related` (8px) between related items, `section` (24px) between sections, and a record row of 44px (`row`) with an 8px inset (`row-inset`). A pointer target is at least 24px (`hit-min`), and 44px on a coarse pointer (`hit-coarse`).

Lists of records are container-aware: below 768px (`--container-abbreviate`) a `ListRowFact` set to `abbreviate` shows its short form, and below 640px (`--container-hide`) a fact set to `hide` is removed. Pages are `@container`s, so this follows the page width, not the window width.

The transcript and composer sit in one centred column capped at Narrow, Default or Wide. Settings pages are centred columns of at most `max-w-2xl`; org sub-pages cap wide bodies at `max-w-3xl`.

## Elevation & Depth

The window has one resting level. The sidebar and the content area are separated by a 1px Hairline border, and regions inside them by hairline dividers, not shadows. Elevation is a state response — an open dialog, popover, tooltip or command palette — never ambient decoration.

### Shadow Vocabulary
- **Field rest** (`shadow-xs`): inputs and outline buttons, so a control reads as pressable on the flat ground.
- **Popover lift** (`shadow-md`; the design-system preview card uses `--shadow-popover`): popovers, menus, selects and preview cards.
- **Dialog lift** (`shadow-lg`): modal dialogs and alert dialogs, to distinguish "what needs my answer now" from the flat resting surface.

### Named Rules
**The Flat Frame Rule.** At rest there is one level. The sidebar and the content area, and the regions inside them, are separated by borders and dividers, not shadows. Elevation appears only in direct response to an open dialog or overlay.

## Shapes

Corners come from one base radius, `--radius` (10px), scaled: controls (buttons, inputs, popovers, tooltips) use 8px (`rounded-md`), dialogs 10px (`rounded-lg`), list rows 6px (`rounded-floor`), checkboxes 5px, and cards 18px (`rounded-card`). Status dots, avatars and scrollbar thumbs are full circles or pills. Borders are 1px Hairline; a status dot's ring is 1.5px (`--status-media-ring`). Nothing uses a sharp 0px corner or a pill-shaped button.

The status dot's fill tells states apart by shape before colour: a dashed ring (not started or idle), a half-filled dot (in progress or parked), a full dot (every other state).

## Components

### Buttons
- **Shape:** gently rounded (8px, `rounded-md`), small and consistent with a native-app control, never sharp-square and never pill-shaped.
- **Primary** (`default`): Signal Indigo fill with Indigo Ink text, 36px tall, used only for the single clear primary action in a given dialog (e.g. "Approve" in a permission prompt). Hover darkens the fill to 90%.
- **Outline:** a 1px border on the background with a `shadow-xs`, for secondary actions that need a visible edge (`Try again`, `Hire…`, `Change`).
- **Ghost:** text only, with a Quiet Fill on hover, for the majority of buttons in dense rows and menus.
- **Secondary:** a Quiet Fill button, used where an action must read as neutral, such as the composer's action button while there is nothing to send.
- **Destructive:** an Error Red fill, only inside an alert dialog that confirms the deletion.
- **Sizes:** `xs` 24px, `sm` 32px, `default` 36px, `lg` 40px, and square `icon` sizes of the same heights.
- **Focus:** the border turns to the ring colour and a 3px ring at 50% opacity (`focus-visible:ring-[3px] ring-ring/50`); no scale or bounce. Disabled is 50% opacity.

### Status Indicator (signature component)
The one component the whole system is built around. A small dot on an agent's overview row and its place in the collapsed rail, in six states: amber with a pulsing ring (needs input), red with a pulsing ring (failed), a neutral dot with a slow opacity pulse (working), a steady half-filled neutral dot (parked: the agent waits for its usage limit to reset), green steady (finished, until the user shows the tab), and a dashed neutral ring (idle). A parked agent turns amber (needs input) only when the user can resume it: its limit has reset, its reset time is unknown, or Claude Code is not signed in. Only amber and red get the ring, because only those states block on the user and also raise an OS notification; the working pulse is slow and neutral so it reads as activity, not as a call for attention. All motion stops under reduced-motion settings, leaving the color. A legend or filter sample renders the dot still (`still`), because it stands for a status rather than reporting one. This is the system's single sanctioned "loud" element per the One Voice Rule. The dot is the design-system `StatusMedia` (10px, a 1.5px ring) coloured per state, so its shapes match every other status dot: full, half-filled (parked) and dashed (idle).

### Toast
The shadcn Base UI toast (`components/ui/toast.tsx`), stacked at the bottom right. dia uses it only for the failure of an action that has no dialog to show it in, such as Unarchive. A failure toast has `type: 'error'`: the title names the action that failed and the agent, the description gives the reason, and its icon is error red per the One Voice Rule.

### Plugin failure
Shown in place of a component a plugin supplied that threw while drawing (`PluginFailed`, the shadcn `Empty` block). In an area of the window, such as the sidebar, the content area, a Settings page or an adapter panel: an error-red warning icon tile, `The <plugin> plugin failed to show this`, the error in mono on the secondary surface (two lines at most), then an outline `Try again` and a ghost `Open Plugins`. In a session rail card: one caption line with a small error-red warning icon, the error in mono on one line, and a `Try again` link. A failed dialog, icon or status line shows nothing.

### Account Banner
A one-line strip under the title bar, above the main tab, shown while any agent is parked because the account refused its turn. Neutral surface, caption-size muted text and ghost buttons, never amber or red. It reads, in priority order: `Claude Code is not signed in. Run claude auth login, then [Retry]`; `Usage limit has reset, 2 agents waiting [Resume all]`; `Usage limit reached, reset time unknown, 2 agents waiting [Resume all]`; `Usage limit reached. You can resume 2 agents at 14:30`; `Usage limit reached. dia resumes 2 agents at 14:30`. The wording names who resumes the agents. A parked agent's transcript ends with a notice and, when only the user can resume it, a `Resume` button. After the resume the notice keeps only its cause, and a `Resumed at 14:35` marker replaces the `continue` message dia sent.

### Workspace Problems
A one-line strip under the Account Banner, shown while dia holds a stored agent or project it could not load, or a tab it skipped when importing an older workspace, that the user has not decided on. Same surface as the Account Banner: neutral, caption-size muted text, never amber or red. It reads `A workspace problem needs your decision` or `2 workspace problems need your decision`, then a ghost `Review` button. `Review` opens a dialog with up to two groups, `Could not be loaded` and `Skipped when importing`, separated rows of: the name in medium weight, a caption (`Agent in dia`, `Project with 3 agents`, `Tab in dia`), and the reason under it. A decode reason is mono; a skipped tab reads `Shares session 9c37a1b2… with brave-otter` with the id or path in mono. A stored row offers ghost `Keep for later` (hidden until dia restarts) and outline `Delete…`, which opens an alert dialog naming what dia deletes from its records and that the worktree directories and Claude Code transcripts stay on disk. A skipped tab offers ghost `Discard` and an outline import button that names what it drops (`Import without its session`). A failed action shows its reason in error red under its row. The strip and dialog go away once nothing is left to decide.

### Agent Overview
- **Purpose:** the left sidebar. It lists every agent in every project, grouped by project, so the user knows which agents need them without opening a tab. It is also the only way to switch tabs: there is no tab strip.
- **Header:** a search input (`Ctrl P` focuses it; `↓` moves into the list; `Enter` with a query shows the first matching agent; `Esc` clears it), a filter icon button whose popover holds one checkbox per status with its count, "Show archived agents", "Hide projects with no matches" and "Clear filters" (a dot on the button marks an active filter), and an add-project icon button that opens the directory picker.
- **Meta group:** pinned above all projects, with a count of open proposals, and hidden while a search or filter applies. A meta branch waiting for approval is a row in this group.
- **Pages:** under the Meta group, one row per page a plugin adds to the `layout` plugin's `PagesSlot` list (ADR-0061), sorted by the page's `order`, then by plugin name and id: its icon and label, the selected-row fill while the page shows, hidden while a search or filter applies. In the collapsed rail each page is its icon after the Meta marker, with the label as tooltip. A page fills the content area under a one-item breadcrumb with its label; selecting an agent closes it.
- **Assistant group:** under Pages and above the projects, shown while the org plugin runs the Executive assistant (ADR-0071) and hidden while a search or filter applies. A caption-size muted `Assistant` label with no chevron, count or New action, over the assistant's one row. The row follows the attached session row rules, with no caption, and its tooltip and accessible name read `Executive assistant` without a project. Its row menu is Show, then Start over after a separator, which replaces the session with one that has an empty transcript; the row stays. Selecting it shows the session under the one-item breadcrumb `Executive assistant`. In the collapsed rail it is a separator and its status dot.
- **Row:** status indicator, tab name, and one caption-size second line. A tab in `bypassPermissions` adds `Full access` at the right end of its name line, in caption size and medium-weight foreground text as in the composer's settings line, and its tooltip and accessible name end with `· Full access`. The second line is the reason for an agent that needs input or failed, else the activity line (the in-progress `TodoWrite` item in sans, else the last tool call in mono). `F2` or the row menu renames the agent in place.
- **Attached session row:** a hired agent's live session (ADR-0070) is a row in its issue's project group, sorted with the tabs. Its name line is the hire's name, then the job title in caption size and muted ink, truncated before the name is; `Full access` stays at the right end. Its tooltip and accessible name read `project / name (job title)`. Status indicator and second line are as for a tab. It is counted in the group's agent count, `F2` does nothing, and the row disappears when the session ends. Selecting it shows the session under the breadcrumb `project / name`, with the transcript and the composer's `queue` and `steer`, but no model, thinking or permission picker and no rewind.
- **Row menu:** Show only on an attached session row, plus Start over on the Assistant group's row. Otherwise Show, Rename, then Archive (Unarchive on an archived agent) and a destructive Delete…. Delete, and Archive of an agent with a worktree, open an alert dialog that names the worktree path it deletes with any uncommitted changes, and the branch and Claude Code transcripts that stay. When the worktree cannot be removed the dialog shows the reason in error red and offers Try again; the agent is left as it was. Unarchive runs at once with no dialog; when the worktree cannot be restored from its branch, an error toast reads `Could not unarchive <name>` above the reason, and the agent stays archived.
- **Order:** project order is fixed and set by the user by dragging a project header, or from the keyboard (`Space` lifts, `↑`/`↓` move, `Space` drops, `Esc` cancels, with the new position announced); a status change never moves a project group. Inside a group, agents sort needs input, failed, parked, working, finished, idle, then by creation. A parked agent's second line reads `Resumes 14:30` when dia resumes it, or `Resets 14:30` when the user does.
- **Overflow:** project groups collapse. A collapsed group's header shows its most urgent status and a count of its agents; while a search or filter applies, every group is open and counts read `n of total`. Groups are separated by a hairline divider. `↑`/`↓` move between headers and rows, `→`/`←` open and close a group, and the list has one tab stop.
- **Project menu:** New agent, Reveal in Explorer, Remove project. Removing a project opens a dialog that lists every agent, worktree and transcript to be removed, enables "Remove" once the project name is typed, and then shows each item's progress.
- **Archived:** a project with archived agents ends with an `Archived (n)` toggle, closed by default, that lists them below it. "Show archived agents" opens every project's list. Showing an archived agent shows its transcript with no composer, above the caption "This agent is archived. Its transcript is read-only."
- **Collapsed rail:** `Ctrl B` or the sidebar toggle in the content header collapses the sidebar to a narrow rail: the Meta marker first, then one status indicator per agent, with a hairline between projects and a tooltip naming project, agent, status and activity.
- **Width:** dragging the sidebar's edge resizes it between 14rem and 32rem (default 18rem); double-clicking the edge resets it, and with the edge focused `←`/`→` resize and `Home` resets. A click on the edge does nothing.
- **Top row:** the `dia` wordmark row is a window drag area, level with the window controls.
- **Selection:** selecting a row shows that agent's tab; the selected row uses a primary-tinted fill and a medium-weight name, never a status color and never an edge stripe.

### Org page
A page the `org` plugin adds to the `PagesSlot` list (Agent Overview › Pages). It fills the content area as a left sub-navigation beside the current sub-page, and opens on Dashboard each time it is shown.
- **Sub-navigation:** `w-44` (11rem) with a right hairline, in two groups under caption-size muted labels, `Overview` (Dashboard, Objectives, Org chart) and `Manage` (Job titles, Hired agents). Entries are `text-sm` buttons with `aria-current="page"`; hover uses the secondary fill and the selected entry uses the primary-tinted fill (`bg-primary/10`) with `font-medium`, never a status color and never an edge stripe, as in the Agent Overview.
- **Sub-page:** a `text-base font-semibold` `h2` naming the page, then the body, in a `px-6 py-5` column that is a container (`@container`). Wide bodies cap at `max-w-3xl`. Loading shows skeletons; a failure shows the reason in error red and an outline `Try again`.
- **Dashboard:** one stat row, `dl grid-cols-3 divide-x border-y`: a caption-size muted term, then a `text-base font-medium tabular-nums` value with `text-sm` muted words after it (`2 of 5 enabled`); the row is divided by hairlines, not cards. `Running at once` carries an outline `xs` `Change` button that opens Settings › Org. Under it, `Needs attention` is a `text-sm font-medium` `h3` over a `List` of items, each a sentence with an outline `sm` action (`Hire…`) in the row's action slot; while the Executive assistant cannot start, the first item is a `role="alert"` `text-sm text-error` sentence with no action, `Executive assistant cannot start: missing github (MCP server), dia-meta:plan (skill)`; with nothing to show it reads one muted line.
- **Org chart:** a tree, not boxes: the `You` root (user icon, medium weight), then nested `ul` levels, each indented `ml-3 pl-3` behind a `border-l` hairline. A node is a button with the agent name in `font-medium` and its job title in caption size, muted; selecting it shows that agent on Hired agents.
- **List and detail:** Job titles and Hired agents share one layout. Stacked, the list is `max-w-sm` above the detail; when the container is `@3xl` or wider, the list is `w-56` beside a detail of at most `max-w-3xl`. The list is a single-select `listbox` (`EntryList`): rows `px-2 py-1.5 text-sm`, the selected row in the same primary-tinted fill with `font-medium`, Arrow Up and Down, Home and End move the selection, and one tab stop. A row's second fact (a hire count in `tabular-nums`, `Disabled`, a job title) is caption size, muted, normal weight, at the row's right end. A Hired agents row is an `Entity`: a 24px avatar with the agent's initials (the job title's initials for an unnamed agent), the name, and the job title as its description.
- **Detail:** a `text-base font-semibold` `h3` name with caption-size muted facts (`Built in`) and actions at the right end of the same line, then sections separated by a `border-t` and titled by a `text-sm font-medium` heading. Fields are the shared input, select and textarea; a hint is caption size muted, a validation error is caption size in error red under its field, and a failed save is a `role="alert"` caption in error red beside the buttons.
- **Objectives:** the list and detail layout, with an outline `sm` `New objective…` above the list. A row shows the objective title and its project as the caption fact; open objectives come first by priority (high, normal, low), then newest, and completed objectives come last with the title muted. The detail is the `h3` title over a `dl` of `SettingsRow`s (Project, Priority, State, Assignee, Description), then an `Issues` section. Issues are a tree in the Org chart's indentation (`ml-3 pl-3 border-l` per level); a row is the title (`text-sm`, muted with a line through it when `Canceled`), under it the first line of the description as a muted caption-size truncated line when the description is not empty, then, on a `Triage` issue the dispatcher refused, a caption-size `text-error` line `Cannot start: missing github (MCP server), dia-meta:plan (skill)`, a caption-size muted `Retro` or `Planning` for those kinds, the status as a `w-24` caption (`issueStatusVariants`: started statuses in full ink and medium weight, every other status muted, `Canceled` struck through, never a status color), an `h-8 w-40` assignee select that is enabled only in `Triage` and `Todo`, and a `w-36` slot holding outline `xs` buttons: `Accept` and `Decline` on a `Triage` issue, `Finish` on a started issue. A comment sits under its issue row before its sub-issues, oldest first, as caption-size text indented `pl-3` without a rule: the author in medium ink (`Dismissed agent` when the agent is gone) over the body in muted `whitespace-pre-wrap`. When the objective has `Triage` issues, a Triage bar sits above the tree, closed by a hairline: the muted count (`2 issues in Triage`, `1 issue in Triage`) and outline `xs` `Accept all` and `Decline all`; it is absent otherwise. A pending decision shows a spinning `Loader2` in its button and disables both buttons of that row or bar. Under the tree, an open objective has one inline row: a `New issue` input, an assignee select and an outline `sm` `Add issue`. With no objectives the page shows the `Empty` block with `No objectives yet` and `New objective…`. While the org host entry is not serving, the page shows one muted `text-sm` line, `The org plugin's host entry is not loaded.`
- **Dialogs:** Hire, New objective and Rename are `Dialog`s (`sm:max-w-md`, `sm:max-w-md` and `sm:max-w-sm`) with a stacked form of `gap-4`; confirmations (dismiss, delete) are alert dialogs (`sm:max-w-md`) that show a failure in error red above the buttons. A pending action shows a spinning `Loader2` in the button, still under reduced motion.

### Tabs
- **One visible:** exactly one agent's tab fills the content area. There are no split panes.
- **Selecting:** a tab is selected from its sidebar row. The content area's header row holds the sidebar toggle, a breadcrumb `project › agent`, the worktree branch when there is one, the transcript width control, the session rail toggle, the bottom panel toggle and the right panel toggle (each only while a plugin has added a panel to it), and the window status (plugin loading, update, `Ctrl K` hint). The header row is a window drag area; its content stays clear of the window controls. A divider separates it from the transcript.
- **Transcript width:** the transcript and composer sit in one centred column, capped at one of three widths (Narrow, Default, Wide) chosen app-wide from the content header or Settings › General; a narrower content area fills the column.
- **Background tabs:** tabs that are not visible keep running and show their status in the sidebar and the collapsed rail only.
- **Messages:** the user's messages sit in a tinted bubble on the right. The agent's text renders as plain Markdown on the left, with no bubble.

### Turn steps
- **Shape:** a native `<details>` in the assistant turn, collapsed by default. Each run of consecutive thinking and tool steps forms one section; the agent's text always stays visible between sections. Expanding a section shows its thinking and tool rows, indented `pl-6` so each row's icon lines up under the summary text. A re-render keeps the open state.
- **Finished summary:** a chevron that turns 90° when open, then `N steps, 12s` in caption size, muted. When one tool call failed it names the tool, `N steps, Bash failed, 12s`; when more failed it counts them, `N steps, 2 failed, 12s`. Either reads in foreground text, not red. A screen reader hears the same text, `3 steps, Bash failed, 12s`. The duration runs from the section's first part to the text after it; it is left out when unknown. Durations of a minute or more read `1m 5s`.
- **Running summary:** the turn's last section shows the activity line in place of the count: a neutral pulsing dot, the latest step (tool name and target in mono, or `Thinking` in sans) or the turn's named state, and the time since the section's first part. It replaces the separate activity line; the dot stops under reduced motion and the label is `aria-live="polite"`. When the turn stalls, the dot stops pulsing, and `Interrupt & retry` and `Resend` show on their own row under the summary, never inside `<summary>`.
- **Tool rows:** a check when the call succeeded, an `X` in foreground text when it failed (screen readers hear "failed"). A row with output is itself a disclosure and shows a `muted/60` background on hover. The target truncates at the row's end and carries its full text as a `title`.
- **Focus:** every `<summary>` in the transcript shows the app ring (`focus-visible:ring-[3px] ring-ring/50`), never the browser's default outline.
- **Not collapsed:** notices, errors, permission, question and plan cards stay outside sections. A turn restored from history, and a turn with no steps, have no section.

### Composer
- **Shape:** one `InputGroup` holding the attachment chips, the text and two controls: Attach (`Plus`) bottom-left and the action button bottom-right. The `Plus` glyph, the text and the settings line's first label share one left edge.
- **Empty session:** while the session has no messages, no running turn and nothing queued, the composer sits centred a little above the pane's middle (its centre at 45% of the height), under one caption line with the project name and, for a worktree, the branch in mono. When the session stops being empty it moves to the bottom edge over 250ms, ease-out; under reduced motion it moves at once.
- **Text:** one line tall when empty; it grows with its text up to about 10 lines (`max-h-60`), then scrolls. The border changes to the ring colour on focus over 150ms.
- **Settings line:** under the box, the model, thinking level and permission mode as borderless text triggers in caption size, for example `Opus 5.5`, `Medium effort`, `Auto mode`, separated by spacing only. Only `Full access mode` (`bypassPermissions`), which skips every approval, reads in foreground weight; every other setting is muted. While the session rail's Context card is not on screen and the context is at 75% or more, or the last compaction failed, the line ends with `78% context` in the context colour; clicking it brings the Context card into view.
- **Action button:** an icon button with no visible text. It is neutral (`secondary`) while there is nothing to send and primary when it can send, with a 150ms colour change; a new icon fades in over 150ms. `ListPlus` means queue, `ArrowUp` means send now, `Square` means stop. The icon follows the turn, the text and the held Cmd/Ctrl key; the accessible name is `Send`, `Queue`, `Steer now` or `Stop`, and a change is announced politely. The tooltip names what Enter does and how to reach the other mode, with `⌘` on macOS and `Ctrl` elsewhere.
- **Queued messages:** a left-ruled separator marker above the composer (`ListPlus`, **20 queued**, then `send in order when this turn ends` or `send with your next message`) and a stack of dashed, opaque, one-line bubbles, right-aligned at most 80% wide. A front bubble with attachments is 54px, with a row of up to four 20px chips and `+N`. The newest is in front; up to three older ones sit 22, 12 and 6px higher, the first at 70% colour with its text, the others as outlines at 55%. Pointer or focus opens the stack upward over the transcript into a 250px list in send order with a faded top edge, where each row shows Send now, Edit and Remove icon buttons on hover or focus. Escape closes it.
- **Attachments:** a row of `Attachment` chips above the text, wrapping. An image shows its thumbnail and opens a preview; a file or folder shows its path relative to the project (`docs/`, `src/main.ts`), or absolute outside it. A rejected file stays as an error chip with its reason (`Too large, 3.75 MB max`) and is not sent; a path gone at send time reads `missing` in the transcript. Files come from Attach, drop (the composer outlines in primary and shows `Drop to attach`), paste, or `@` with a path menu. Backspace at the start of an empty caret removes the last chip.
- **Placeholder:** names what sending does now: `Message this agent, or type / for commands` while idle, `Queue a message for after this turn, or type / for commands` or `Steer this turn, or type / for commands` during a turn.

### Session rail
- **Shape:** a column of cards, 288px wide, 16px in from the top and right edges of the session pane, over the transcript. The column has no panel, border or background; the pane shows between the cards. Each card has a hairline border and the surface colour (`bg-card`), with no shadow, per the Flat Frame Rule.
- **Card:** a caption-size muted title and a `⋯` button, then the body a plugin renders. The `⋯` popover lists every card with a checkbox; unchecking one hides it. When every card is hidden, one small card reads `All cards hidden` with `Show cards`.
- **Cards from dia:** Context (the share of the context window in use, the token counts, a meter coloured neutral up to 50%, amber by 75% and red at the auto-compact threshold or after a failed compaction, `Compact conversation`, and why the last compaction did not run; `No usage yet` before the first reading), Background tasks (each task's description; `None running`), Task list (the last `TodoWrite` list, the in-progress item in foreground text, completed items struck through; `No task list`). An empty card keeps one muted line so the column does not change height.
- **Room:** the cards show only while they fit beside the transcript column: the pane must be at least the column's maximum width plus 320px. While they show, the column moves left only as far as the cards need, over 200ms. When they do not fit they are hidden.
- **Toggle:** the header's `GalleryVerticalEnd` button, `Ctrl Shift B` (`⌘ Shift B` on macOS). While the cards fit it turns them on or off, saved app-wide. While they do not fit it shows them over the transcript until a pointer or focus goes outside them, or `Escape`. The rail is not shown in an empty session.
- **Plugins:** a plugin adds a card to the `chat` plugin's `RailCardsSlot` list (ADR-0061). Cards are ordered by their `order`, then by plugin name and id; which cards are hidden is saved app-wide.

### Right panel
- **Shape:** a region at the right of the session pane, beside the transcript, not over it. A 1px Hairline left border separates it from the transcript; it has the pane's background and no shadow, per the Flat Frame Rule. It is closed by default.
- **Header:** a 40px row over a hairline divider. With one panel it shows the panel's title in caption size; with two or more it shows a borderless `Select` of the panels' titles instead.
- **Body:** the panel a plugin renders for the tab, scrolling within the region.
- **Panels from dia:** Changes (each turn of the run, newest first and separated by hairlines, headed by `Turn 3`, the prompt in medium weight and `2 files +14 −3` in muted tabular figures; each file row shows the name, its folder muted and its line counts, and opens to its patch in place with no height cap; `No changes yet`, or `Not a git repository` when the run's directory is outside a repository).
- **Width:** 400px until the user drags the left edge; at least 240px, and never wide enough to leave the transcript area under 400px. A narrowing window shrinks the region before the transcript. The edge is a focusable separator: arrow keys step 16px, `Home` or a double-click returns to 400px.
- **Per tab:** each tab keeps its own open state, chosen panel and width while dia runs; after a restart every tab is closed.
- **Toggle:** the header's `PanelRight` button, `Ctrl Alt B` (`⌘ ⌥ B` on macOS), pressed while the region is open. It is hidden while no plugin has added a panel.
- **With the session rail:** the rail cards stay over the transcript area. Whether they fit is measured on the transcript area that remains beside the region.
- **Plugins:** a plugin adds a panel to the `chat` plugin's `PanelsSlot` list (ADR-0061). Every panel applies to every chat tab; panels are ordered by their `order`, then by plugin name and id. An archived tab shows no region.

### Bottom panel
- **Shape:** a region under the transcript and composer of the session pane, not over them. It spans the transcript area only; the right panel beside it keeps its full height. A 1px Hairline top border separates it from the composer; it has the pane's background and no shadow, per the Flat Frame Rule. It is closed by default.
- **Header:** a 40px row over a hairline divider. With one panel it shows the panel's title in caption size; with two or more it shows the same borderless `Select` of the panels' titles as the right panel.
- **Body:** the panel a plugin renders for the tab. The body does not scroll as a whole; the panel sizes itself to the region.
- **Height:** 280px until the user drags the top edge; at least 160px, and never tall enough to leave the transcript and composer under 240px. The edge is a focusable separator: `ArrowUp` and `ArrowDown` step 16px, `Home` or a double-click returns to 280px.
- **Per tab:** each tab keeps its own open state, chosen panel and height while dia runs; after a restart every tab is closed.
- **Toggle:** the header's `PanelBottom` button, `Ctrl J` (`⌘ J` on macOS), pressed while the region is open. The shortcut is handled before the focused element receives it, so it works while a terminal has focus. It is hidden while no plugin has added a bottom panel.
- **Plugins:** a plugin adds a panel to the `chat` plugin's `BottomPanelsSlot` list (ADR-0061). Every panel applies to every chat tab; panels are ordered by their `order`, then by plugin name and id. An archived tab shows no region.

### Inputs / Fields
- **Style:** a 1px Hairline border on a transparent background (`bg-input/30` in the dark theme), 8px corners, 36px tall, `shadow-xs`, muted placeholder.
- **Focus:** the border turns to the ring colour and a 3px ring at 50% opacity, the same treatment as buttons.
- **Error / Disabled:** an invalid field (`aria-invalid`) has an Error Red border and ring, per the One Voice Rule, with the message in caption size Error Red under it; it does not pulse. Disabled is 50% opacity.

### Record lists
Lists of comparable records use the draekien/design-system registry components in `src/renderer/src/components` (`list.tsx`, `status.tsx`, `entity.tsx`, `figure.tsx`, `relative-time.tsx`, `meter.tsx`, `table.tsx`, `preview-card.tsx`), which plugins import from `@dia/renderer-plugin`. They draw on dia's tokens, not the registry's own theme.
- **List:** 44px rows with 6px corners and no dividers, one tab stop, `↑`/`↓`/`Home`/`End` between rows of that list only (a `List` nested in a row is its own list). A row is `ListRowSubject` (name, then a muted description), one `ListRowFact` per compared value, and buttons or a menu in `ListRowAction`. A row with no page of its own renders its `ListRowLink` as a `div`. Loading rows are `ListRowLoading` with the same parts. Free-form detail under a row spans the grid with `col-span-full`.
- **Status:** a `StatusMedia` dot, then `StatusName`, then an optional muted `StatusDescription`. The dot's fill is the state's progress (`none`, `half`, `full`); its colour is Muted Slate or Slate Ink, and Error Red only for a failed state.
- **Entity:** a 24px `EntityMedia` avatar with initials (`initials()` from `@dia/renderer-plugin`) on Raised Sheet, then `EntityName` and an optional `EntityDescription`.
- **Figure** and **RelativeTime:** a number in tabular figures and a moment relative to now; both switch to a short form in an abbreviated fact.
- **Where:** Settings › Plugins, MCP servers, Meta repo findings, Worktrees and Claude Code; the Org dashboard's Needs attention; the Issues page and objective screen. The Org page's Job titles and Hired agents lists stay a single-select `listbox` (`EntryList`), because `List` moves focus without selecting.

### Navigation
The sidebar is the primary navigation. Any command palette or agent switcher reads as an overlay (Raycast-style), not a further persistent chrome element. Every setting lives in one Settings dialog (General, Adapters, Plugins and Meta repo in a left nav, plus one page per plugin that adds one, such as Org, a breadcrumb over the page). The Org settings page is a centred `max-w-2xl` column of labelled number fields, each with a caption-size muted hint and an error-red message. Meta repo shows the remote and branch, adds or changes the remote, and pushes; a refused push lists each finding by description, `file:line` and short commit in mono, under one line in error red, and never the secret; the command palette has one Settings item, and its search also lists each Settings page.

## Do's and Don'ts

### Do:
- **Do** keep color roles deliberate: primary for action/selection, the cool neutrals for structure, amber for warnings, red for errors and green for a finished agent, per the One Voice Rule.
- **Do** use mono for all literal agent/session content and sans for all dia chrome, per the Content-Is-Mono Rule.
- **Do** keep to the one resting level, reserving elevation for dialogs and overlays, per the Flat Frame Rule.
- **Do** make motion responsive to real actions (tab switch, row selection, status change) — confirm, don't choreograph.
- **Do** draw a list of comparable records with `List`, its states with `Status`, people and agents with `Entity`, and compared numbers with `Figure`, per Record lists.

### Don't:
- **Don't** build a generic AI-chat-SaaS look — no gradient hero treatments, no bubble-chat marketing polish, nothing that reads as a hosted product's landing page.
- **Don't** default to a raw terminal-multiplexer aesthetic — no bare ASCII-art borders, no zero-chrome-for-its-own-sake tmux-default look.
- **Don't** use amber, red or green for decoration or emphasis; they mean warning, error and finished.
- **Don't** separate text with a middle dot (U+00B7), per the No Middle Dot Rule.
- **Don't** pulse for a finished agent; a finished agent does not need the user, and a pulse there makes the needs-input pulse easier to ignore.
- **Don't** hand-roll a record list as a `<ul className="divide-y">` with its own row markup, or draw a status as a bespoke dot; use the Record lists components.

---
version: 1
slug: "plugins-org-org-page-tsx"
primary_target: "plugins/org/org-page.tsx"
related_targets: ["plugins/org/org-settings-page.tsx","plugins/org/job-title-editor.tsx","plugins/org/agents-page.tsx","plugins/org/dashboard.tsx","plugins/org/org-chart.tsx"]
---

Scope: the Org page (content area, `PagesSlot`) with its four sub-pages, the Hire dialog, and the Org Settings page (`SettingsPagesSlot`) of the `org` plugin, issue #178. Mode: Operate.

Audience and job: William, running the org of hired agents: who is hired, who reports to whom, what each job title does and allows, and whether anything needs him. Visited rarely and briefly; correctness and scanability outrank expression.

## Direction contract

THESIS: the org as five views, each answering one question (what needs me, what work is each objective in, who reports to whom, what does each job title do, what is each agent set to), with every action placed on the view that owns its subject.

OWN-WORLD: dia's existing world unchanged: cool-neutral ground, hairline dividers, no cards or shadows at rest, the agent overview's primary-tinted selected-row fill, sans for chrome, mono for skills, permission rules and MCP JSON, error red only for validation and failures, no amber (nothing on these views is a warning).

STORY: the user opens Org on Dashboard, sees the counts and whether anything needs attention, creates an objective and follows its tasks on Objectives, moves to Org chart to read the reporting tree, opens an agent from a node, and changes its name, manager or bypass setting in Hired agents; job titles are read and edited in Job titles.

FIRST VIEWPORT: content header `Org`. Under it, an in-page nav column on the left, 11rem, two caption-labelled groups, Overview (Dashboard, Objectives, Org chart) and Manage (Job titles, Hired agents), the current entry in the selected-row fill. To its right the sub-page under its own heading: on Dashboard a hairline-divided row of three stats, then `Needs attention` with its one row or `Nothing needs attention.`

FORM: in-page left nav in captioned groups (the Settings dialog's nav form), list-and-detail splits inside it; seed:d97819fee3097e563f5254977ff5a5db, dealt 6 locked by the agent on the user's instruction to proceed without stopping.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Objective screen: issues

Operate-mode refinement of `plugins/org/objective-screen.tsx`, no new visual direction. Issues use the Linear status vocabulary (Triage, Todo, Understanding, Designing, Implementing, Testing, Verifying, In Review, Done, Canceled). A `Triage` issue row carries `Accept` and `Decline` outline `xs` buttons; a Triage bar above the issue tree shows the count and `Accept all` / `Decline all`, and is absent when nothing is in Triage. Each row shows the first description line as a muted truncated caption; a `Canceled` title is muted with a line through it. Comments sit under their issue as caption-size text, author in medium ink over a muted body, with `Dismissed agent` for a removed author. No cards, no status colors, no edge stripes; error red only in failure toasts.

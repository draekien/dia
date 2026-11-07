---
version: 1
slug: "plugins-org-org-page-tsx"
primary_target: "plugins/org/org-page.tsx"
related_targets: ["plugins/org/org-settings-page.tsx","plugins/org/role-editor.tsx"]
---

Scope: the Org page (content area, `PagesSlot`) and the Org Settings page (`SettingsPagesSlot`) of the `org` plugin, issue #178. Mode: Operate.

Audience and job: William, configuring the org he runs: which roles exist and are enabled, what each role does, and which agents are hired into it. Visited rarely and briefly; correctness and scanability outrank expression.

## Direction contract

THESIS: one role at a time, with everything about it in one place: its settings and the agents hired into it. Refuses the admin default of a long roles list and a separate hires list joined only by a caption.

OWN-WORLD: dia's existing world unchanged: cool-neutral ground, hairline dividers, no cards or shadows at rest, the agent overview's primary-tinted selected-row fill, sans for chrome, mono for skills, permission rules and MCP JSON, amber only on the retro warning dot, error red only for validation and failures.

STORY: the user sees which role has no retro hire or is disabled, selects a role, reads and edits its instructions and rules in place, and hires, renames or dismisses its agents without leaving it.

FIRST VIEWPORT: content header with the `Org` breadcrumb. Under it, when no retro is hired, one hairline-bounded strip: amber dot, the warning sentence, outline `Hire retro` or `Enable retro`. Below, a 14rem role list on the left (name, hire count right-aligned, a disabled role in muted text with `Disabled`, a copy without `Built in`) and the selected role's detail on the right, max 48rem: a heading row with the role name, its enabled switch, then outline `Copy…`, `Hire…` and, on copies, `Delete…`; the form fields (name for copies only, instructions, skills, allow / ask / deny side by side, MCP servers, bypass opt-in); `Save`; then `Hired agents in this role` rows. Below 48rem of content width the list sits above the detail.

FORM: master-detail split, position 2 on the ordered list; seed:cea7de28bd90ee6d.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

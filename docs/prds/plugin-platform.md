# dia plugin platform — PRD

## Problem Statement

William is the sole user and developer of dia. Every dia feature (pane sessions, permission handling, thinking level, worktrees, split layout, chat UI, updater) is fixed code in `src/main` and `src/renderer`. Changing how dia behaves means editing that code in a dev checkout, building, and restarting the app. A restart ends every running agent turn in the app being restarted. When he notices something he wants dia to do differently while using it, he has to stop the work in progress, switch to a separate development loop, and come back later. dia cannot be changed while it runs, and an agent in a dia pane cannot change dia's behaviour and check the result itself.

## Goals / Success Criteria

1. Every feature listed in `docs/prds/mvp.md` runs as a built-in plugin that can be disabled or replaced, with no feature left in the kernel beyond agent session lifetime, Host supervision, the renderer–Host transport and the plugin registry (ADR-0019).
2. With hot reload on, a saved edit to an overridden plugin's source is active in the installed app within 2 seconds, with no app restart.
3. Across at least 20 plugin reloads performed while another pane's turn is streaming, zero turns are interrupted, dropped or duplicated.
4. A plugin that fails to load or reload leaves every other plugin and every pane session running, and its error is shown in the plugin panel, in 100% of failures observed during testing.
5. Dogfooding milestone: an agent in a dia pane, working in a worktree of the dia repo, edits a plugin, loads it with `plugin_override`, checks the changed behaviour, and opens a pull request with `gh pr create`, with no action from William other than approving permission prompts.
6. Two panes in two worktrees refine two different plugins at the same time, and each refinement becomes its own pull request containing only that plugin's changes.
7. Every `plugin_*` tool call produces a permission prompt in the calling pane unless that pane's permission mode auto-approves it, with zero calls that change plugins without approval observed during testing.
8. The installed app with no overrides set starts and runs every built-in plugin with no dia checkout present on the machine.
9. All `docs/prds/mvp.md` success criteria that held before the platform work still hold after Phase 1 and after each Phase 4 feature migration in `docs/plans/2026-10-22-plugin-platform.md`.

## User Stories

1. As a user, I want every dia feature to be a plugin so that I can change or replace any part of dia, not only the parts with an extension hook.
2. As a user, I want to switch on hot reload in the installed app so that edits to a plugin take effect while dia runs.
3. As a user, I want a plugin reload to leave running turns in every pane untouched so that changing dia never costs me work in progress.
4. As a user, I want to point a single plugin at its source in a pane's worktree so that I can refine that plugin while every other plugin keeps its installed version.
5. As a user, I want several panes to refine different plugins in different worktrees at the same time so that plugin work runs in parallel like any other work in dia.
6. As a user, I want the agent in a pane to load and reload the plugin it is editing so that it can check its own change without me stepping in after every edit.
7. As a user, I want to approve each plugin load or reload an agent requests so that no agent changes dia's behaviour for every pane without my consent.
8. As a user, I want a plugin panel that lists every plugin, where each one loads from, and its last load error so that I can see what is running and why something failed.
9. As a user, I want to set and clear a plugin's source override from the plugin panel so that I can manage overrides without asking an agent.
10. As a user, I want a plugin that fails to reload to stay unloaded with its error shown, while the rest of dia keeps running, so that a broken edit is visible and contained.
11. As a user, I want each plugin refinement to sit on its own worktree branch so that the agent can open one pull request per refinement.
12. As a user, I want the installed app to fall back to a plugin's shipped version once I clear its override so that I return to the released behaviour after a refinement ships.
13. As a user, I want a plugin that observes several panes to be written once against one context so that cross-pane behaviour (for example, a sound when any pane finishes a turn) needs no inter-process wiring.
14. As a user, I want dia to refuse a plugin built for a different plugin API version so that an incompatible plugin fails at load time with a clear message instead of misbehaving.

## Testing Decisions

**Approach:** Automated tests cover logic that can be checked in isolation: the plugin registry (a plugin's registrations are released when its scope closes; dependants restart when a service they depend on changes), manifest decoding and API-version rejection, override resolution (default copy, override path, most-recent override wins, clearing an override), mapping a changed file to the plugin entry that owns it, and message decoding at the Host transport boundary. Manual testing on the installed build covers hot reload timing, turn survival during reloads in another pane, failed-reload containment, the plugin panel, the `plugin_*` permission prompts, two parallel worktree refinements, the agent-driven edit → reload → pull request loop, and a run with no checkout present.

**Constraints:** No production or customer data is involved. Testing runs on the developer's machine against his local Claude Code installation and the dia repository.

## Out of Scope

- Third-party plugins, including installing a plugin from a GitHub repository (roadmap in `docs/plans/2026-10-22-plugin-platform.md`)
- A trust or sandbox model for plugins; first-party plugins run with full Node access
- Loading plugins written for cordis, Koishi or deepseek-harness
- A browser, phone or other client of the Host besides the Electron renderer
- A dia feature that opens pull requests; the pane's agent uses `gh`
- Preserving a plugin's in-memory state across its own reload; a reloaded plugin starts with fresh state
- Keeping running turns alive across a dia core update or a Host restart; those interrupt turns, which resume from their saved session
- A plugin market, index or search

## Additional Notes

This PRD builds on four architecture decisions made for it: a thin plugin kernel on Effect (ADR-0019), source loading with per-plugin worktree overrides and hot reload (ADR-0020), one Host process for all panes (ADR-0021, superseding ADR-0003 and ADR-0007), and an authenticated localhost WebSocket between renderer and Host (ADR-0022). Delivery is phased in `docs/plans/2026-10-22-plugin-platform.md`, with dia usable after each phase. The design follows `deepseek-ai/deepseek-harness` and `cordiverse/cordis`, with one deliberate difference: the agent session is kernel-owned rather than a plugin, so that goal 3 holds.

Since 2026-10-23 dia shows one agent per tab within registered projects instead of split panes (ADR-0023, `docs/prds/agent-os.md`). "Pane" in this PRD means a tab's agent session.

## Open Questions

- Whether source loading works in the packaged app's Host process: verified in Phase 0 (`docs/reasoning/2026-10-22-plugin-platform-phase-0-spike.md`).
- What renderer plugins can replace — named slots only, or the whole layout — is decided during step 3 of `docs/plans/2026-10-23-agent-os.md`, which replaced the layout step of Phase 4.
- The plugin manifest fields and API-version rule were settled in Phase 2: `plugin.json` has `name`, `api`, `host`, `renderer` and `inject`, and a plugin whose `api` differs from the installed version fails to load.

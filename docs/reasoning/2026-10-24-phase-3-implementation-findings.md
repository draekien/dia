# Phase 3 implementation: reload memory numbers, tool approval by permission mode, and traps while driving the app

**Date:** 2026-10-24

## Context

Phase 3 of `docs/plans/2026-10-22-plugin-platform.md` (issue #8) was built and then run in the unpackaged app (Electron 43.1.0, Windows 11, `electron .` with `--remote-debugging-port`, driven through `window.dia` over CDP, with `workspace.json` and `settings.json` backed up and restored). The numbers and behaviours below were measured in that run; none was measured in a packaged build.

## Reasoning / Learning

### Reload memory

| Run | Result |
| --- | --- |
| 200 source edits to `plugins/example` (a new export of growing size per edit, one `load` after each) | The plugin's total went from 19.7 MB to 22.3 MB (about 13 KB per edit). The Host's working set went from 137 MB to 145 MB. 200 edits plus reloads took 4.7 s |
| Fixture plugin whose module holds a 300 000-object array, one edit per reload | The total rose about 7.2 MB per edit: 29.2 MB after edit 1, 101.3 MB after edit 11. Edit 12 returned `RestartRequired` with reason `memory`, imported nothing, and `unload` afterwards returned `Unloaded` |

- **The first total includes one-time costs.** `plugins/example` showed 19.7 MB before any edit, because the first tracked load of the first plugin includes costs that happen once in the Host. The likely sources are tsx's start-up and the first evaluation of the Host's copy of `effect`; which of them it is was not measured. A limit of 100 MB therefore leaves about 80 MB for edits of the first plugin.
- **An unchanged reload does not grow the total.** The second load with no edit changed it from 19.72 MB to 19.45 MB; a total can fall because the heap is measured after a collection.
- **The forced collection worked in the unpackaged Host.** The per-edit growth was a steady 7.2 MB for the array fixture, which it would not be if uncollected garbage were included. Not tried in a packaged build.

### Approval of the agent tools by permission mode

Tested with a real agent in dia (a pane created from a `splitPane` placeholder, model `claude-haiku-4-5-20251001`), calling `mcp__dia__plugin_reload`, with the script answering each permission request.

| Pane mode | Permission request shown to the user | Result for the agent |
| --- | --- | --- |
| `auto` | one | allowed: the tool ran and returned `Plugin "example" is loaded.` |
| `default`, user declines | one | `The user did not approve this plugin change.`; nothing reloaded |
| `acceptEdits` | one | the tool ran |
| `dontAsk` | none | the SDK refused the call before the handler; the agent reported it needed permission |

- **`auto` asks.** The SDK documentation leaves `auto` for MCP tools unverified; the tool's own approval made the question moot, and it was asked once.
- **`bypassPermissions` was not tested in this run.** dia had no such pane mode then; it now offers it as "Full access". Because the approval is inside the tool handler, it does not depend on the SDK calling `canUseTool`.
- **`canUseTool` must let the tools through.** The handler asks, so `makeCanUseTool` returns `allow` for these tool names; otherwise `default` mode would ask twice.

### Traps while driving the app

- `createPane` fails with `PaneNotFoundError` unless the id came from a `pending` leaf made by `splitPane`. The initial pane (`00000000-0000-0000-0000-000000000001`) is already `ready`; writing to it would add messages to the user's real session.
- `window.dia.onPermissionRequested` listeners accumulate in the page across scripts. A leftover "allow" listener answered a later "deny" run, so the first deny result was invalid. Reload the renderer (`location.reload()`) between scenarios.
- A syntax error in a plugin's `.ts` file reaches `reloadError` as a long message that starts with tsx's CommonJS shim text. The plugin page shows it in a height-limited, wrapped mono block.
- `vitest`'s module runner rewrites dynamic `import()`, so Node's `module.registerHooks` resolve hook never runs inside a vitest test. The loader's behaviour is tested by a child `node --import tsx` process (`src/host/plugins/fixtures/plugin-modules-driver.mjs`) with `TSX_TSCONFIG_PATH=tsconfig.base.json` so `@shared/*` resolves.

## Implication

- If the first-load baseline matters, exclude the first tracked load from the total or raise the limit; neither was done.
- Re-run the 100 MB run in a packaged build before relying on the safeguard there; if `--expose-gc` is unavailable, totals include uncollected garbage and the limit trips early.
- Any new manual agent test in dia needs a `splitPane` placeholder and a renderer reload between scenarios.

# Agent notifications

Scope: layer. Plan step 4 of `docs/plans/2026-10-23-agent-os.md`, issue #15. One PR, stacked on #129.

Governing decisions: ADR-0019 (every feature is a plugin that uses the plugin API a user plugin can use), ADR-0021 (one Host process), ADR-0024 (the Host is a `utilityProcess`, so Electron main shows the notification; closing the window quits dia). Product rules: `PRODUCT.md` (Notifications; Accessibility & Inclusion: the text names the project, the agent and the reason). PRD goals 1 to 3 and user stories 7 to 10 of `docs/prds/agent-os.md`.

## Success criteria

1. A permission request, a question or a failure from an agent whose tab is not visible raises one OS notification.
2. The same from the visible agent raises one OS notification when dia's window is minimised, not focused or hidden; it raises none when the window is shown and focused.
3. A status that is derived again, or a request that is emitted again, without the status changing raises no second notification.
4. A finished turn raises no notification; a background agent's row shows finished (green) until its tab is shown.
5. The notification's title names the agent and the project, and its body names the reason.
6. Clicking the notification restores, shows and focuses the window and shows the agent's tab, which marks its row selected.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Who decides when to notify | A Host built-in feature plugin, `plugins/notifications` | The issue asks for it; ADR-0019 makes every feature a plugin. A kernel service next to `AgentSummaries` would need less plumbing but would add a feature to the kernel against an accepted ADR |
| What the plugin needs from the kernel | Two new `HostPluginContext` members: `workspace` (the workspace now, then after each change) and `window` (`attended`: whether the user can see the window, now and after each change; `notify`: show an OS notification). `PLUGIN_API_VERSION` 0.0.12 to 0.0.13 | The rule needs project and agent names and the visible tab (only in the workspace), and the window state (only in main). `ctx.events` carries `WorkspaceChanged` but no current value, so a plugin that starts after the workspace loads would not know it |
| Where the workspace stream comes from | A kernel `WorkspaceFeed` service holding the workspace in a `SubscriptionRef`; `PaneWorkspace` keeps its state in it instead of a private `Ref` | `PaneWorkspace` depends on `HostPlugins`, so `HostPlugins` cannot depend on `PaneWorkspace`; a feed service with no dependencies breaks the cycle and stays the single source of truth |
| Where the window state lives | Main sends `WindowAttention { attended }` to the Host on `focus`, `blur`, `show`, `hide`, `minimize` and `restore`, and once after every Host start; the Host's `AppWindow` service holds it | Keeps the whole rule in the plugin, where it is tested without Electron |
| Main ↔ Host messages | `parentPort` messages in `src/shared/ipc/host-process.ts`: Host to main `Notify`; main to Host `WindowAttention` and `ShowAgent` | Main already talks to the Host over `parentPort` (ADR-0024); `DiaRpcs` and `PROTOCOL_VERSION` do not change |
| Click | Main restores, shows and focuses the window and sends `ShowAgent { paneId }`; the Host runs `PaneWorkspace.selectTab`, whose `WorkspaceChanged` makes the renderer show the tab and mark its row | The renderer already follows the visible tab; the click works while the renderer reloads |
| Duplicates | Notify only when the agent's status changes into a notifying status (`Equal.equals` on the previous status); `AgentSummaries` publishes only changed summaries | A re-emitted request or a re-derived status yields an equal status. Two separate requests are separated by `StatusWorking`, so each notifies |
| Which statuses notify | `StatusNeedsInput` (permission request, question, plan review, an agent parked for the user) and `StatusFailed`, in one table of status tag to reason text | `PRODUCT.md` and `DESIGN.md` (Status Indicator): amber and red are the states that block on the user and raise a notification. #41 adds decision-queue items as another row source in the same table |
| One notification per agent | Main keeps the latest notification per agent and closes the earlier one when a new one is shown | Keeps the Action Center to one entry per agent and keeps a reference so the `click` listener is not garbage collected |
| Windows AppUserModelID | `app.setAppUserModelId` with the electron-builder `appId` (`com.draekien.dia`, or `com.draekien.dia.nightly` for the nightly app name); `process.execPath` in development | Windows toasts are attributed to the AppUserModelID of a Start Menu shortcut (Electron Notifications tutorial, v45). The NSIS installer sets the shortcut's AUMI to `appId` (`app-builder-lib/templates/nsis/include/installer.nsh`, `WinShell::SetLnkAUMI`); Electron sets it automatically only for Squirrel installs |
| Tray | No tray work | ADR-0024 keeps "closing the window quits dia"; #11 is closed. A hidden window counts as not attended, and the click calls `show()` |
| Collapsed group or active filter | Not expanded or cleared on click | Selecting a tab from search behaves the same today; the content area shows the agent either way |

## Interface

### Shared — `src/shared/domain/notification.ts`

```ts
/** An OS notification about one agent: `title` and `body` are shown; clicking it shows `paneId`'s tab. */
export const AgentNotification = Schema.Struct({ paneId: Schema.String, title: Schema.String, body: Schema.String })
export type AgentNotification = typeof AgentNotification.Type
```

### Shared — `src/shared/ipc/host-process.ts`

```ts
export const Notify = Schema.TaggedStruct('Notify', { notification: AgentNotification })            // Host -> main
export const WindowAttention = Schema.TaggedStruct('WindowAttention', { attended: Schema.Boolean }) // main -> Host
export const ShowAgent = Schema.TaggedStruct('ShowAgent', { paneId: Schema.String })                // main -> Host
```

### Shared — `src/shared/plugin/api.ts`

```ts
export interface PluginWindow {
  readonly attended: Stream.Stream<boolean>                                  // now, then each change
  readonly notify: (notification: AgentNotification) => Effect.Effect<void>
}
export interface HostPluginContext extends PluginServices {
  // existing members ...
  readonly workspace: Stream.Stream<Workspace>                               // now, then each change
  readonly window: PluginWindow
}
```

### Host — kernel

- `WorkspaceFeed` (`src/host/services/workspace-feed.ts`): `Context.Service<WorkspaceFeed, SubscriptionRef<Workspace>>`, `WorkspaceFeedLive` starts at `EMPTY_WORKSPACE`. `PaneWorkspace` sets it on construction and on every change.
- `AppWindow` (`src/host/services/app-window.ts`): `attended: Stream<boolean>` (starts `true`), `setAttended(attended)`, `notify(notification)`. `makeAppWindowLive(post)` takes the function that posts a `HostToMainMessage`.
- `makeHostPluginsLive` requires both and fills `ctx.workspace` and `ctx.window`.
- `runHost` handles `WindowAttention` with `AppWindow.setAttended` and `ShowAgent` with `PaneWorkspace.selectTab`, logging a refused tab.

### Plugin — `plugins/notifications`

- `notification-rule.ts`: `RuleInput` (`WorkspaceInput`, `AttendedInput`, `SummaryInput`), `RuleState`, `INITIAL_RULE_STATE`, and `stepRule(state, input): [RuleState, ReadonlyArray<AgentNotification>]`. A `SummaryInput` yields a notification when the status's tag has a reason in the table, differs from the agent's previous status, the agent has a tab in the workspace, and the tab is not visible or the window is not attended. Title: `<agent> in <project>`; body: `Needs input: <reason>` or `Failed: <reason>`.
- `host.ts`: merges `ctx.workspace`, `ctx.window.attended` and the `AgentSummaryChanged` events of `ctx.events` into `RuleInput`s, folds them with `stepRule`, and calls `ctx.window.notify` for each notification, in a fiber forked into the plugin's scope.

### Main

- `src/main/agent-notifications.ts`: `isWindowAttended(window)`, `watchWindowAttention(window, report)`, `makeAgentNotifier(window, onClick)`.
- `startHostProcess` gains `onNotify(notification)`, `readyMessages` (sent to each Host once it is ready) and `HostProcess.send(message)`.
- `src/main/index.ts` sets the AppUserModelID, logs each shown notification's pane, title and body, and wires the three.

## Refinement Record

Runner inline, effort low (one round), because the task forbids extra subagents.

**Applied**
- *Correctness* — the first draft let the plugin read the workspace from `WorkspaceChanged` events only; a plugin started after the workspace loaded would never see the first workspace. Added `ctx.workspace`, which starts with the current value.
- *Correctness* — the Host could miss the window state after a Host restart; main now resends it in `readyMessages` after every start.
- *Avoid Temporal Decomposition* — the window rule was split between the Host (tab visibility) and main (focus). Moved the whole rule into the plugin; main only reports state and shows notifications.

**Rejected**
- *Strategic Programming* — `AgentNotification.paneId` ties a notification to an agent, which a future decision-queue item may not have. Rejected: every item in `PRODUCT.md`'s Notifications rule belongs to an agent, and the click needs a target tab.

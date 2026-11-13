# Windows toasts need the installer shortcut's AppUserModelID; plugins cannot read `PaneWorkspace`

**Date:** 2026-11-01

## Context

Issue #15 added OS notifications. Electron main shows them with `Notification`, and a Host built-in plugin (`plugins/dia-notifications`) decides when, from the workspace and the window state.

## Reasoning / Learning

- Windows attributes a toast to the process's AppUserModelID and shows it for an ID that a Start Menu shortcut carries (Electron Notifications tutorial, v45). Electron sets the ID itself only for Squirrel installs. dia ships an NSIS installer, whose shortcut gets electron-builder's `appId` (`app-builder-lib/templates/nsis/include/installer.nsh`, `WinShell::SetLnkAUMI "${APP_ID}"`). `src/main/index.ts` therefore calls `app.setAppUserModelId` with `com.draekien.dia`, or `com.draekien.dia.nightly` when the app name is `dia-nightly` (the nightly workflow overrides `appId` and the name), and with `process.execPath` in development.
- An `electron-builder --dir` build has no shortcut of its own. On a machine where dia is installed, its toasts appear under the installed dia's shortcut, because they share `com.draekien.dia`. On a machine without dia installed, a `--dir` build's toasts were not checked.
- Windows suppresses toasts while a full-screen app runs (Do Not Disturb for games). The Host still logs `Asked main to show a notification` and main logs `Showing an agent notification` with the title and body, so check the log, not the screen, to count notifications.
- `makeHostPluginsLive` cannot depend on `PaneWorkspace`: `PaneWorkspace` depends on `HostPlugins`, so layering one into the other is a cycle. The workspace reaches plugins through `WorkspaceFeed`, a `SubscriptionRef` with no dependencies that `PaneWorkspace` keeps its state in.

## Implication

Keep the AppUserModelID in `src/main/index.ts` equal to `appId` in `electron-builder.yml` and to the nightly workflow's `-c.appId`. Give plugins new kernel state through a dependency-free service like `WorkspaceFeed`, not through `PaneWorkspace`.

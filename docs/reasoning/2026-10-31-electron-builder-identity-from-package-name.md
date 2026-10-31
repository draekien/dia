# A second app identity needs `extraMetadata.name`, not only `productName`

**Date:** 2026-10-31

## Context

ADR-0044 builds a side-by-side `dia-nightly` app from the same repository with electron-builder CLI overrides. The first plan overrode `productName` and `extraMetadata.productName` to `dia-nightly`, on the assumption that the product name decides where the app keeps its data.

## Reasoning / Learning

dia's `package.json` has `name: "dia"` and no `productName`. Two per-install directories derive from the packaged `package.json` `name`:

| Directory | Derived by | Source |
| --- | --- | --- |
| `%APPDATA%\<app name>` (`userData`) | Electron `app.getName()`: `productName` if present in the packaged `package.json`, else `name` | `electron/electron` `docs/api/app.md`, `app.getName()` |
| `%LOCALAPPDATA%\<name>-updater` (downloaded updates) | electron-builder `updaterCacheDirName`: `sanitizedName.toLowerCase() + "-updater"`, where `name` is `metadata.name` | `app-builder-lib/src/appInfo.ts` L145-161 at `electron-builder@26.18.1` |

The electron-builder config key `productName` sets the exe, installer and shortcut names, but it is not written into the packaged `package.json`; only `extraMetadata` keys are. Overriding only `productName` therefore leaves `updaterCacheDirName` as `dia-updater`, shared with the stable install.

A local build with `-c.productName=dia-nightly -c.extraMetadata.name=dia-nightly -c.extraMetadata.version=0.0.16-nightly.1` produced:

- `dia-nightly.exe` and `dia-nightly-Setup-0.0.16-nightly.1.exe`
- packaged `package.json` `{"name":"dia-nightly","version":"0.0.16-nightly.1"}` with no `productName`
- `resources/app-update.yml` with `channel: nightly` and `updaterCacheDirName: dia-nightly-updater`

## Implication

Any build that must not share `userData` or the updater cache with stable overrides `extraMetadata.name`. `src/main/index.ts` calls `app.setName` only for the unpackaged dev build (`dia-dev`), so it does not affect packaged builds. Adding a `productName` to `package.json` would change the stable app's `userData` from `%APPDATA%\dia` to `%APPDATA%\<productName>` and orphan existing stable data.

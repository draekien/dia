# Running the dev build alongside installed production

**Date:** 2026-07-20

## Context

Dogfooding needs the dev app (`electron-vite dev`) to run at the same time as an
installed production dia. Launching both produced Chromium/profile "conflict"
exceptions (LevelDB / cache / singleton locks).

## Reasoning / Learning

Every persistent path — `workspace.json`, `settings.json`, `worktrees/`, and
Chromium's *own* profile, cache, and `SingletonLock` files — is derived from
`app.getPath('userData')`, which is keyed off the app name. Both builds resolve
to the same name (`package.json` `name` and electron-builder `productName` are
both `dia`), so both point `userData` at `%APPDATA%/dia` and collide at the
filesystem layer. There was no `requestSingleInstanceLock`, so nothing rejected
the second process cleanly — it just fought over the shared profile. (The log
file was already split — dev writes repo-local `dia.log` — which is exactly the
kind of isolation `userData` was missing.)

Fix, at module top level *before* `whenReady` and before any `getPath('userData')`:

- `isDev` → `app.setName('dia-dev')` + `app.setPath('userData', join(app.getPath('appData'), 'dia-dev'))`. `appData` is the roaming root (`%APPDATA%`), *not* name-derived, so this cleanly relocates dev to `%APPDATA%/dia-dev` and leaves production untouched.
- `requestSingleInstanceLock()`; if not acquired, `app.quit()`, and guard the `whenReady` body with an early `return` so a losing instance never creates a window / touches the profile before quit lands. A `second-instance` handler restores+focuses the existing window.

The single-instance lock is keyed to `userData`, so this composes exactly right:
dev (`dia-dev`) and prod (`dia`) hold *separate* locks and coexist, while a
second launch of the *same* build collides and focuses the first.

## Implication

Dev gets a fresh, empty workspace (separate profile) — desirable for dogfooding,
but don't expect prod history to appear in dev. Any future name/`productName`
change must keep the dev override in step. This bootstrap runs before the Effect
logger exists, so it uses plain Electron calls, not Effect logging.

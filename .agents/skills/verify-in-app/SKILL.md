---
name: verify-in-app
description: "Launches the real dia Electron app (dev or packaged build) and drives it over CDP to prove a change works, recording what was run and observed as PR proof. Use when a change needs checking in the running app, before raising a PR, or when the user says \"run the app\", \"verify it in the app\", \"prove it works\"."
argument-hint: "[--build dev|packaged] [behaviour-to-prove]"
---

# Verify a change in the running dia app

Tests show the code does what the tests expect; this skill shows the shipped app does what the change claims. A run of the real app has caught what tests could not: a plugin import that resolved under vitest failed in the packaged build with `Cannot find package 'redis'`. The output is a **proof record** that `raise-pr` copies into the PR body.

## Available scripts

- **`scripts/cdp-eval.mjs`** — evaluates one JavaScript expression in the dia window over CDP once `window.dia` exists, and prints `{"value": ...}` or `{"exception": ...}` as one JSON line. Run `node scripts/cdp-eval.mjs --help` for flags and exit codes. Requires Node 22+ (global `WebSocket`). `scripts/` paths resolve from this skill's directory; every other command runs from the repo root.

## Plan the proof

Before launching anything, write down each behaviour the change claims and the observable value that proves it: a `window.dia` call's return value, an event payload, a file on disk, a `git` command's output, a line in the app log. For a bug fix, include the steps that reproduced the bug, and run them on `main` as well when the before/after contrast is the proof.

Completion criterion: every claimed behaviour has a named observation that would differ if the change were wrong.

## Choose the build

| Build | Use when | Profile |
| --- | --- | --- |
| `dev` (unpackaged) | the change is in renderer, host or plugin logic | the real `%APPDATA%\dia-dev` — back it up first |
| `packaged` | the change touches startup, plugin loading from `out/`, dependencies, native modules, `electron-builder.yml`, or anything outside `out/**` and `plugins/**` | a scratch profile from `--user-data-dir` |

If `--build` is given, use it. Otherwise pick from the table; when both rows or neither apply, run `packaged`: it is the build users install.

## Run a dev build

1. **Back up the profile.** A dev build reads and writes the real `%APPDATA%\dia-dev` and ignores `--user-data-dir`. Copy `workspace.json` and `settings.json` to a new backup directory outside the repo, and note which of the two did not exist. Then move `workspace.json` away: a restored workspace can hold a session id the SDK no longer has, which crashes the pane. Without it, the initial pane `00000000-0000-0000-0000-000000000001` has status `pending`.
2. **Build and launch.**

   ```sh
   pnpm exec electron-vite build
   env -u ELECTRON_RUN_AS_NODE pnpm exec electron . --remote-debugging-port=9333 > app.log 2>&1 &
   ```

3. **Drive and observe** — see Drive the window.
4. **Restore the profile — also when the run fails or is abandoned.** Stop the app (see Gotchas), copy each backed-up file back over the profile, and delete any profile file that had no backup.

Completion criterion: the profile files match their backups byte for byte.

## Run a packaged build

```sh
pnpm exec electron-vite build
pnpm exec electron-builder --win --dir --config.directories.output=<scratch> --config.win.signAndEditExecutable=false
env -u ELECTRON_RUN_AS_NODE <scratch>/win-unpacked/dia.exe --user-data-dir=<scratch-profile> --remote-debugging-port=9333 > app.log 2>&1 &
```

Put `<scratch>` and `<scratch-profile>` in a new directory outside the repo. The scratch profile needs no backup. Drive it as in Drive the window, then stop the app (see Gotchas).

## Drive the window

Call `window.dia` through the script. Register listeners on `window` first, act, then read what they collected:

```sh
node scripts/cdp-eval.mjs --port 9333 "window.__events = []; window.dia.onMessageAppended((...args) => window.__events.push(args)); true"
node scripts/cdp-eval.mjs --port 9333 "window.dia.createPane('00000000-0000-0000-0000-000000000001', 'F:/Dev/dia', 'claude-sonnet-5', 'off', 'default', false)"
node scripts/cdp-eval.mjs --port 9333 "const box = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Reply with the word ready'); box.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => document.querySelector('button[aria-label=\"Send message\"]').click(), 100); true"
node scripts/cdp-eval.mjs --port 9333 "window.__events.length"
```

The pane id `00000000-0000-0000-0000-000000000001` is the initial pane only with `workspace.json` moved away (dev) or on a fresh scratch profile (packaged). The third command sends the prompt through the composer: it fills the `textarea` and clicks `Send message`. The click returns before the turn ends: re-read the collected value until it reaches the expected state, up to a stated limit such as 60 s, and record a timeout as a failed observation. `--timeout-ms` does not bound the expression itself.

Read `src/preload` for the current `window.dia` surface rather than guessing a method's arguments. For a change in a git-backed feature, run it against a throwaway git repo, not this one.

Completion criterion: every observation named in the plan was read from the running app, and every line of `app.log` containing `error` or `Unhandled` is listed with whether it is expected.

## Proof record

Return this to the caller (or to the user when run on its own):

```markdown
- Commit `<sha>`, <build: unpackaged | `electron-builder --dir`>, <profile: backed-up dia-dev | scratch>, <fixture: e.g. throwaway git repo>: <steps taken> → <observed values, quoted>.
- Before the change, the same steps <observed values> (bug fixes only).
- Not exercised: <claimed behaviour not reached, and why>.
```

## Gotchas

- **`ELECTRON_RUN_AS_NODE` is set in shells started from an Electron-based app.** `electron .` then runs `out/main/index.js` as plain Node and fails with `The requested module 'electron' does not provide an export named 'BrowserWindow'`. Always launch with `env -u ELECTRON_RUN_AS_NODE`.
- **Overriding `APPDATA` does not isolate a dev build.** Electron resolves `appData` from the Windows known-folder API. Only a packaged build honours `--user-data-dir`.
- **Write Windows paths with forward slashes in expressions** (`'F:/Dev/dia'`); backslashes are lost between the shell and JavaScript.
- **Send prompts through the composer, not `window.dia.sendMessage`.** The renderer adds the user turn to the pane's transcript in `paneSendAtom` (`src/renderer/src/lib/pane-chat-atoms.ts`) before it calls `window.dia.sendMessage`. A direct `window.dia.sendMessage` call reaches the agent, but the user turn never appears in the pane, and a later rewind cannot truncate the transcript at that turn.
- **Events published before a listener registers are not replayed** on the first connection. Register listeners before the action that emits them.
- **`kill $!` does not stop the app.** Electron's main, renderer, GPU and Host processes outlive the shell job. Find the main process by its command line (this run's `--remote-debugging-port` or scratch path) and stop its whole tree: `taskkill //PID <pid> //T //F`. Never stop all `dia.exe` or `electron.exe` processes, which ends the user's own dia window.
- **`electron .` runs the last build.** Rebuild after every source change, or the run proves the old code.

# node-pty in the packaged Host: load it from `app.asar.unpacked`, and wait for exits on close

**Date:** 2026-11-13

## Context

`dia-terminals` (ADR-0079, `docs/designs/dia-terminals.md`) runs PTYs through `@lydell/node-pty` in the Host's `utilityProcess`. Two problems appeared: one in the packaging design, one in the tests.

## Reasoning / Learning

* **The worker path.** On Windows node-pty starts `lib/worker/conoutSocketWorker.js` with `new Worker(join(scriptPath, ...))`, where `scriptPath = __dirname.replace('node_modules.asar', 'node_modules.asar.unpacked')` (`lib/windowsConoutConnection.js`). That rewrite is for VS Code's layout. In dia's layout the path is `resources/app.asar/node_modules/...`, so the rewrite does nothing, and `asarUnpack` alone leaves `__dirname` inside `app.asar`. `pty-terminals.ts` therefore resolves `@lydell/node-pty` with `createRequire(import.meta.url).resolve`, replaces the `app.asar` path segment with `app.asar.unpacked`, and requires that path. `__dirname` is then a real directory, so the worker, `conpty.node` and the platform package all load from disk. Verified in an `electron-builder --dir` build and in the NSIS installer's payload: the Host process had `resources\app.asar.unpacked\node_modules\@lydell\node-pty-win32-x64\prebuilds\win32-x64\conpty.node` loaded.
* **`kill()` returns before the process exits.** A scoped test that opened a shell in a `makeTempDirectoryScoped` directory failed with `EBUSY: resource busy or locked, rmdir`: the terminals' finalizer killed the shell, then the temp directory's finalizer ran while the shell still held it as its working directory. The finalizer now kills every process and waits up to 5 seconds for each `onExit`. It waits on a `Deferred` completed in the `onExit` callback, not on the per-terminal event fiber, because fibers forked in the same scope are interrupted before an earlier-registered finalizer runs.
* Under plain Node (`ELECTRON_RUN_AS_NODE`), a script that spawns a PTY does not exit by itself after the PTY exits; vitest is not affected.

## Implication

Any other native package that starts a worker or a helper from `__dirname` needs the same treatment: `asarUnpack` plus loading it by its unpacked path. A scoped owner of child processes waits for their exit before its scope closes, or a later finalizer that deletes their directory fails on Windows.

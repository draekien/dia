# Plugin platform Phase 1: orphaned `claude` processes, log flush on shutdown, WebSocket upgrade pitfalls

**Date:** 2026-10-23

## Context

Phase 1 of `docs/plans/2026-10-22-plugin-platform.md` (issue #6) moved every pane's agent session into one Host `utilityProcess` behind an `effect/rpc` WebSocket. Building and running it produced six findings that are not visible from the code.

Test setup for the manual runs: Windows 11, Electron 43.1.0, built with `pnpm build` and run with `electron .` (unpackaged), and built with `electron-builder --win --dir` and run as `dist/win-unpacked/dia.exe` (packaged). The app was driven over the Chrome DevTools Protocol with `--remote-debugging-port`, using `window.dia` calls in the renderer page.

## Reasoning / Learning

### `claude` processes end when the Host dies (Windows)

The plan required checking whether the Agent SDK ends its `claude` child when the parent dies. Method: start a pane session, list the Host's descendants, `Stop-Process -Force` the Host, and list which of those PIDs still exist.

| State when the Host was killed | Descendants of the Host | Alive 5 s later |
| --- | --- | --- |
| Pane idle after a reply | `claude.exe` and its MCP server tree (`cmd`, `node`, `cmd`, `node` for `npx shadcn mcp`) | none |
| Pane with a `Bash` tool call started about 1 s earlier (the call takes about 11 s) | `claude.exe` and its MCP server tree | none (checked again about a minute later: still none) |

No extra mechanism was added. The observed cause is that `claude.exe` reads its input from a stdin pipe the Host owns; when the Host dies the pipe closes and `claude.exe` exits, and its MCP servers exit when `claude.exe` does. This was not verified by reading the Claude Code source. It was not checked with a model turn that was generating text at the instant of the kill, because every attempted generation finished within 8 s. If a future Claude Code version keeps running after stdin closes, add a Windows job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` around the spawn.

The Host's own graceful shutdown (`supervisor.closeAll`) closes each query, and main kills the Host after 10 s if `ShutdownComplete` does not arrive.

### The log file is flushed only when the logger's scope closes

`makeLoggerLive` batches writes for 5 s (`LOG_BATCH_WINDOW`) and flushes on scope close. Main kills the Host as soon as it receives `ShutdownComplete`, so the last batch, including `Host shutting down` and `Closing query`, was lost and the graceful path looked as if it never ran. The Host now closes the scope that holds its layers before it posts `ShutdownComplete`.

A second cause: `runHost` logged `Host listening` and `Host shutting down` outside the built layer's context, so those lines went to the utility process's default console, which nothing captures. The code after `Layer.build` now runs with `Effect.provideContext(context)`.

Verification that needs no log file: main prints `Asking the Host to shut down` and `Host shut down cleanly` to stdout.

### A WebSocket upgrade handler must run the reader before writing

`request.upgrade` returns a `Socket` whose writer waits until the reader has opened the underlying WebSocket. The RPC protocol's own `onSocket` runs the reader. A handler that only writes (here, the `CLOSE_PROTOCOL_MISMATCH` close frame) never sends anything, and the client sees close code 1006 or a 500 response. The handler runs `socket.reader` in a forked fiber, writes the `CloseEvent`, then joins the fiber so the response does not end the connection before the close handshake finishes.

### Testing the server: three traps

- `RpcClient.make(DiaRpcs).pipe(Effect.provide(protocolLayer))` scopes the protocol layer to `make` alone, so the socket closes as soon as the client is constructed and every call times out. Build the layer into the test's scope with `Layer.build` and use `Effect.provideContext`.
- A client from `RpcClient.layerProtocolSocket()` does not fail a call when the server closes the socket with an application code; it waits for a reconnect. Assert the close code with a raw `ws` client.
- `vitest`'s `it.effect` uses `TestClock`; the server test uses `it.live` because the sockets use real time.

### `window.dia` listeners attach after the first events

`makeHostApi` starts consuming `SubscribeEvents` when the preload runs, with no cursors, so a pane event published before the renderer registers its listener is not replayed. A reconnect resumes from cursors and replays; the first connection does not. The window between preload and the first React mount was not measured, and no change was made for it.

### Running a dev build touches the real profile

- Main sets `userData` to `%APPDATA%\dia-dev` for an unpackaged build and ignores `--user-data-dir`, and Electron on Windows resolves `appData` from the known-folder API, so overriding the `APPDATA` environment variable does nothing. A manual run reads and writes the developer's real `dia-dev` workspace. A packaged build uses `%APPDATA%\dia`.
- Back up `workspace.json` and `settings.json` before a manual run and restore them after.
- If the shell that launches Electron comes from an Electron-based app, `ELECTRON_RUN_AS_NODE` is set and `electron .` runs `out/main/index.js` as plain Node (`The requested module 'electron' does not provide an export named 'BrowserWindow'`). Launch with `env -u ELECTRON_RUN_AS_NODE`.

## Implication

- Keep the Host's shutdown order: close each pane's query, close the layer scope, then post `ShutdownComplete`.
- Test any new WebSocket upgrade branch with a real client; a unit test of the handler alone cannot show that the writer is gated on the reader.
- Re-run the orphan check (kill the Host, list descendants) whenever the Agent SDK or Claude Code is upgraded.

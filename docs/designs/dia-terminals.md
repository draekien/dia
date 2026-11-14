# `dia-terminals` plugin

Issue: draekien/dia#250, step 12 of `docs/plans/2026-11-13-foundation.md`. Decisions: ADR-0076 ("Terminals and processes" row), ADR-0079 (PTY library). Builds on `dia-runs` (`RunsKey`, run id = pane id) and `dia-tools` (`ToolsKey`).

`dia-terminals` runs pseudo-terminals (PTYs) for runs. A plugin or the user opens a shell, or starts a command, in a run's working directory; the plugin keeps each terminal's recent output, lists a run's terminals with their state, and stops them. A run starts, reads and stops its own commands through three dia tools. A `Terminals` panel in the chat's bottom panel shows one tab per terminal of the run and the selected one in an xterm.js view that takes keyboard input. The name `dia-terminals` is the issue's provisional name and is kept.

## Success criteria

1. A plugin opens a PTY in a run's working directory and the renderer shows it. (Test: `terminals.test.ts` opens a terminal for a run whose `cwd` is a temp directory with the command that prints the working directory; its output contains that directory (compared after `fs.realPath`), and `list` shows it running, then exited with code 0. App: in the `Terminals` bottom panel press `New terminal`; a PowerShell prompt in the run's directory appears and `echo hi` typed into it prints `hi`.)
2. A process a run started is listed and stoppable. (Test: `terminal-tools.test.ts` calls `terminal_start` with a long-running command for a run scope; `list` shows it running; `terminal_stop` with the returned id leaves it exited; `terminal_read`/`terminal_stop` from another run's scope are refused. App: ask the agent to start a long-running command with `terminal_start`; it appears in the `Terminals` bottom panel; `Stop` ends it.)
3. The packaged installer starts on a clean Windows machine. (App: `electron-builder --dir` build and the NSIS installer build launch, the plugin loads, and a terminal opens from the packaged app, with `@lydell/node-pty` loaded from `app.asar.unpacked`.)
4. Output a follower attaches to late is replayed. (Test: `output` subscribed after the command has printed and exited emits the retained output, then completes.)

## Decisions taken without the user

D1. **PTY library: `@lydell/node-pty`** (ADR-0079). It is Microsoft's `node-pty` 1.2 beta repackaged as one JavaScript package plus one optional package per platform holding a prebuilt N-API binary (`conpty.node` on Windows); it has no install script, so `pnpm install --frozen-lockfile` needs no `allowBuilds` entry and no compiler, and N-API needs no rebuild for Electron's ABI. Verified 2026-11-13: under `ELECTRON_RUN_AS_NODE` with Electron 45 it spawned `powershell.exe` in a given `cwd` and returned its output and exit code. The installer gains the `@lydell/**` folders under `asarUnpack`. The plugin loads the package from its unpacked path (the resolved path with `app.asar` replaced by `app.asar.unpacked`, the `src/main/host-process.ts` precedent for esbuild), because node-pty starts `lib/worker/conoutSocketWorker.js` with `new Worker(path)` from `__dirname`, and its own rewrite matches `node_modules.asar`, not dia's `app.asar` (`windowsConoutConnection.js`); loaded from the unpacked path, `__dirname` is a real directory, so neither the worker nor the `.node` file depends on asar support in a `utilityProcess`. Criterion 3 checks this in a packaged build. This is the kind of native module ADR-0042's decision driver ruled out for the database. ADR-0079, written in this change, records the PTY choice and amends that driver: it applies to storage, and a native module is acceptable for terminals when it has no install script and ships N-API prebuilds. Alternatives: Microsoft `node-pty` 1.1.0 (rejected: an install script that pnpm 11 blocks unless `allowBuilds` names it, `binding.gyp` that falls back to `node-gyp` and a compiler, no Linux prebuild, and it also ships winpty, which dia does not use); `@homebridge/node-pty-prebuilt-multiarch` (rejected: `prebuild-install` downloads an ABI-specific binary from GitHub at install time, so an Electron upgrade needs a matching release and CI needs the network for it); `child_process` with pipes and no PTY (rejected: programs see no terminal, so shells print no prompt and interactive and coloured output is off, which is not a terminal).

D2. **A terminal belongs to one run and opens in that run's `cwd` as `Runs.list` reports it.** `open` takes a run id, not a directory, so a caller cannot open a terminal for a run in some other directory. When `dia-runs` is not provided or the run is unknown, `open` fails with `TerminalOpenError`.

D3. **Terminals live in the plugin's setup scope, not in the `dia-runs` provision scope.** A reload of `dia-runs` does not kill a dev server a run started; `open` reads the current `Runs` from a `SubscriptionRef` (the `dia-checkpoints` precedent). Reloading or unloading `dia-terminals`, or quitting dia, kills every terminal. A retired run's terminals stay until removed or dia quits (no `RunChange` reports a retirement).

D4. **Shell and command.** With no command, Windows opens `powershell.exe -NoLogo` (present on every Windows install; `pwsh` is not), other platforms `$SHELL` or `/bin/sh`. A command runs as `powershell.exe -NoLogo -NoProfile -Command <command>`, elsewhere `<shell> -c <command>`. The terminal's title is the command, or the shell's name. The PTY gets the Host's environment, 80×24 to start; the renderer resizes it to its view.

D5. **A terminal's lifecycle is `Running` → `Exited`, and `remove` drops it.** `stop` kills a running terminal and keeps it listed as `Exited` so its output stays readable; `remove` kills it if running and drops it from the list. `write`, `resize` and `stop` on an unknown or exited terminal do nothing, and `output` of an unknown terminal is an empty stream, so callers handle no not-found error. node-pty throws when a PTY that has just exited is resized (`windowsPtyAgent.js`), so `write` and `resize` run under `Effect.try` and a failure from that race is logged at debug level; `kill()` is called with no signal (Windows throws on a signal). The exit code after `stop` on Windows is whatever ConPTY reports (unverified; no test asserts it).

D6. **Retained output: about the last 1 MiB of characters per terminal**: whole chunks drop from the front while the total exceeds 1 MiB, and a single chunk over 1 MiB keeps its last 1 MiB. `output(terminalId)` emits the retained text as one chunk, then each new chunk, and completes when the terminal exits or is removed. Retaining and publishing a chunk happen under the terminal store's one-permit `Semaphore`, as does a follower's snapshot-and-subscribe, so a follower sees no chunk twice and misses none. Alternative: t3code's history files on disk (rejected: terminals do not survive a restart here, so a file buys nothing).

D7. **Run tools: `terminal_start`, `terminal_read`, `terminal_stop`, registered with `when: isRunScope`** while `ToolsKey` is provided. `terminal_start { command }` starts `command` in the calling run's terminal and returns its id; `terminal_read { terminalId }` returns its state and the last 8,000 characters of retained output with ANSI escape sequences removed; `terminal_stop { terminalId }` stops it. A run may read and stop only its own terminals; any other id is refused with `isError`. The tools exist so "a process a run started" is a process the run started through dia, which the `Terminals` bottom panel lists and stops. Alternative: list and stop Claude Code's own background tasks (`BackgroundTasksChanged`, the SDK's `Query.stopTask`) (rejected for this step: those processes belong to the Claude Code CLI, which dia does not spawn, so stopping them is a change to the `AgentBackend` contract in `dia-runs` and `dia-claude-code`, not a terminal service; the `Background tasks` card keeps listing them).

D8. **The renderer shows terminals in a `Terminals` panel of the chat's bottom panel** (`BottomPanelsSlot`, order 10), for the visible pane's run: a row of tabs, one per terminal (the title in mono with a half-filled dot while running and a full dot once exited, the exit code in the tab's tooltip), a `Stop` or `Remove` button for the selected terminal and a `New terminal` icon button, then an xterm.js view (`@xterm/xterm`, `@xterm/addon-fit`) of the selected terminal that `FitAddon.fit()` sizes to the panel's width and height on every resize, writing keystrokes with `WriteTerminal` and reporting its size with `ResizeTerminal`. The newest terminal is selected when none is. With no terminals the panel shows `No terminals` and a `New terminal` button. `Ctrl J` toggles the bottom panel even while the terminal has focus, because the bottom panel handles it on `window` in the capture phase, before xterm's textarea receives it. Alternative: the `Terminals` card on the session rail (replaced: a 288px card with a 16-row view is too small for a dev server's output; the bottom panel gives the terminal the transcript area's width).

D9. **The service contract is an exported module, `plugins/dia-terminals/terminals.ts`**, imported as `@dia-plugin/dia-terminals/terminals` (the `dia-tools/tools.ts` precedent; root `CLAUDE.md`: a contract only plugins use lives in the owning plugin).

## Interface

### Exported module (`plugins/dia-terminals/terminals.ts`)

```ts
/** A terminal whose process runs. `title` is its command, or the shell's name. */
export const TerminalRunning = Schema.TaggedStruct('TerminalRunning', { terminalId: Schema.String, runId: Schema.String, title: Schema.String })
/** A terminal whose process ended with `exitCode`; its output stays readable until it is removed. */
export const TerminalExited = Schema.TaggedStruct('TerminalExited', { terminalId: Schema.String, runId: Schema.String, title: Schema.String, exitCode: Schema.Int })
/** One terminal of a run. */
export const TerminalInfo = Schema.Union([TerminalRunning, TerminalExited])
export type TerminalInfo = typeof TerminalInfo.Type

/** A terminal could not open for run `runId`: runs are not provided, the run is unknown, or the process failed to start (`message`). */
export class TerminalOpenError extends Schema.TaggedError<TerminalOpenError>()('TerminalOpenError', { runId: Schema.String, message: Schema.String }) {}

/** PTYs per run, as `dia-terminals` provides them under {@link TerminalsKey}. Read it with `ctx.whenProvided`. */
export interface Terminals {
  /** Opens a PTY in run `runId`'s working directory running `command`, or an interactive shell when it is undefined. */
  readonly open: (runId: string, command?: string) => Effect.Effect<TerminalInfo, TerminalOpenError>
  /** Run `runId`'s terminals in opening order, now and after each change. */
  readonly list: (runId: string) => Stream.Stream<ReadonlyArray<TerminalInfo>>
  /** The terminal's retained output as one chunk, then each new chunk; completes when it exits or is removed. Empty for an unknown id. */
  readonly output: (terminalId: string) => Stream.Stream<string>
  /** The terminal's state and its retained output now, for a caller that reads once (the `terminal_read` tool). None for an unknown id. */
  readonly read: (terminalId: string) => Effect.Effect<Option.Option<{ readonly info: TerminalInfo; readonly output: string }>>
  /** Sends `data` as typed input. Does nothing unless the terminal runs. */
  readonly write: (terminalId: string, data: string) => Effect.Effect<void>
  /** Sets the terminal's size in character cells. Does nothing unless it runs. */
  readonly resize: (terminalId: string, cols: number, rows: number) => Effect.Effect<void>
  /** Kills the terminal's process; it stays listed as exited. Does nothing unless it runs. */
  readonly stop: (terminalId: string) => Effect.Effect<void>
  /** Stops the terminal if it runs and drops it from its run's list. */
  readonly remove: (terminalId: string) => Effect.Effect<void>
}

const isTerminals = (value: unknown): value is Terminals => /* every member is a function */
/** The key `dia-terminals` provides {@link Terminals} under: `terminals`. */
export const TerminalsKey = ServiceKey.make('terminals', isTerminals)
```

`plugin.json`: `category: feature`, `host: host.ts`, `renderer: renderer.ts`, `load: eager`, `exports: ["terminals.ts"]`; `tsconfig.plugin-exports.json` includes it.

### Calls (`calls.ts`, used by the plugin's own renderer)

`FollowTerminals { runId } → stream TerminalInfo[]`, `OpenTerminal { runId } → TerminalInfo, error TerminalOpenError`, `FollowTerminalOutput { terminalId } → stream string`, `WriteTerminal { terminalId, data }`, `ResizeTerminal { terminalId, cols: Int ≥ 1, rows: Int ≥ 1 }`, `StopTerminal { terminalId }`, `RemoveTerminal { terminalId }`.

### Internal modules

- `pty-terminals.ts` — `makeTerminals(cwdOf: (runId) => Effect<Option<string>>)`: owns the PTY processes, their retained output and the per-run lists; scoped, so closing the scope kills every process. Calls `@lydell/node-pty` `spawn`. Builds every `TerminalInfo` with `TerminalRunning.make`/`TerminalExited.make`; logs open, exit, stop and remove at info level with `terminalId`, `runId` and `exitCode`.
- `shell.ts` — `shellCommand(platform, env, command?)`: the file and arguments of D4. (Test: on Windows a command containing double quotes and `&` runs as written.)
- `terminal-tools.ts` — `makeTerminalTools(terminals)`: the three `DiaTool`s of D7; `terminal_read` removes escape sequences with Node's `util.stripVTControlCharacters`.
- `host.ts` — makes the terminals in the setup scope, provides `TerminalsKey`, keeps `Runs` in a `SubscriptionRef` under `whenProvided([RunsKey])`, registers the tools under `whenProvided([ToolsKey])`, serves the calls.
- `terminals-panel.tsx`, `renderer.ts` — the bottom panel of D8, built under `src/renderer/CLAUDE.md` (impeccable, shadcn).

### Packaging

`electron-builder.yml` `asarUnpack` gains `node_modules/@lydell/**`.

## Refinement Record

**Round 1 (subagent, sonnet) — applied**
- *Correctness, blocker* — node-pty's worker path rewrite matches `node_modules.asar`, not `app.asar`; the plugin now loads the package from its `app.asar.unpacked` path (D1).
- *Correctness, major* — `resize` throws on a just-exited PTY and `kill(signal)` throws on Windows; `Effect.try` and a signal-less kill (D5).
- *Correctness, major* — the exit code after a Windows kill is marked unverified (D5).
- *Correctness, major* — the 1 MiB rule is stated for a chunk larger than the limit (D6).
- *Project rules, major* — `isTerminals` and `TerminalsKey` JSDoc; logging and `.make` named for `pty-terminals.ts`; renderer rules cited.
- *Minor* — the lock is a `Semaphore` (D6); `read`'s JSDoc says why it exists beside `output`; a `shell.ts` quoting test; dependency versions dropped from prose.

**Round 1 — rejected or changed**
- *Project rules, blocker: move D1 to an open question for the user* — rejected: the user authorised decisions without them for this run; ADR-0079 is written in this change and records the amendment of ADR-0042's driver.
- *A test that a chunk emitted while a follower attaches appears once* — rejected: the race cannot be triggered deterministically from a test; the guarantee rests on the `Semaphore`, and criterion 4 covers replay.
- *`open` drops terminals of runs `Runs.list` no longer reports* — rejected: archived runs stay in `Runs.list`, so it would only cover deleted runs, and terminals are user- or run-opened and end when dia quits (D3).

**Round 2 (inline) — no blocker or major finding.** Minor, applied: none. Rounds stopped early after round 2.

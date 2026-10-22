# Effect v4 migration: changes that type-check but break at runtime

**Date:** 2026-10-22

## Context

dia moved from `effect@3.21.4` to `effect@4.0.5` (with `@effect/platform-node`, `@effect/vitest` and `@effect/atom-react` at `4.0.5`, and `vitest@5`). After the migration, `pnpm typecheck` was clean and all 279 tests passed, but launching the dev app exposed two defects that neither check caught.

## Reasoning / Learning

- **`Schema.isUUID()` is stricter than v3 `Schema.UUID`.** v3 accepted any `8-4-4-4-12` hex string (`/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i`). v4 `Schema.isUUID()` also requires a version digit of 1–8. The migration reference maps `Schema.UUID` to `Schema.String.check(isUUID())`, but that rejects dia's `INITIAL_PANE_ID` (`00000000-0000-0000-0000-000000000001`, version digit 0) and therefore every `workspace.json` a v3 build saved. Startup then failed to build the pane workspace and registered no IPC handlers. dia now uses `Uuid` from `src/shared/domain/uuid.ts`, which keeps v3's pattern.
- **A logger layer merged beside the app layer does not reach the app layer's construction.** `Effect.provide(Layer.mergeAll(appLayer, LoggerLive, Layer.succeed(References.MinimumLogLevel, ...)))` gives the loggers to the program but not to the effects that build `appLayer`, which is where the workspace loads and pane processes spawn. Those logs went to the default logger and never reached `dia.log`. `src/main/index.ts` now provides the logging layers to `appLayer` with `Layer.provideMerge`.
- **Recursive schemas need `Schema.Codec<T>`, not `Schema.Schema<T>`.** In v4 `Schema.Schema<T>` has no encoding side, so `Schema.encodeSync` of any schema containing it fails to type-check (`ConstraintEncoder` error), even far from the recursive schema. This one the type-check does catch, but the error points at the encoding call site, not at the annotation.
- **A pane's last events can be lost when its scope closes.** In `src/main/services/pane-supervisor.ts`, a crashed pane's exit handler puts `Crashed` on the outbound queue with `markCrashed`, then calls `teardown`, which closes the pane's scope and interrupts the fiber forwarding the queue to the renderer. Under v3 the forwarding fiber received `Crashed` before the interrupt; under v4 it did not, and the test "removes a pane that crashes unexpectedly" failed. An `Effect.yieldNow` between `markCrashed` and `teardown` lets the forwarding fiber run first. That depends on fiber scheduling order and on the gateway's `onEvent` not suspending. Phase 1 of `docs/plans/2026-10-22-plugin-platform.md` requires the Host to close the queue and wait for the forwarding fiber instead.
- **The JSON log line format changed.** `Logger.formatJson` writes `level` where v3's `Logger.jsonLogger` wrote `logLevel`, writes a single message unwrapped instead of as a one-element array, and adds a `cause` field. `pruneOldLogEntries` reads only `timestamp`, which both formats write.

## Implication

For a dependency major-version upgrade, a clean type-check and test run are not enough. Launch the app against state written by the previous version (the dev profile's `workspace.json`), and check that logs from layer construction reach the log file. When a migration reference maps a validator to a new one, check that the new one accepts every value the old one accepted, including constants the app writes itself.

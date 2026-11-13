# A run started before `dia-runs` recovery was marked interrupted

**Date:** 2026-11-13

## Context

In the in-app proof of `dia-schedules` (#247), a schedule with the `once` catch-up rule fired at launch. Its run answered, but its tab also showed "The turn was interrupted before it started. Send your message again." The log showed `Recovering runs whose turn was in progress` listing the run the schedule had started 160 ms earlier.

## Reasoning / Learning

`dia-runs` provides `RunsKey` during setup and runs `recover` later, in a fiber that waits for `ctx.pluginsSettled` and an agent backend (`plugins/dia-runs/host.ts`). Any plugin can call `Runs.start` in that gap. `recover` read every row whose status was `running`; a run started in the gap has that status and no session id yet, so `recover` called `interruptedBeforeStart` on it, setting its row `idle` and appending the error notice while its session was still running the turn.

`recover` now skips every row whose run is already live (present in the registry's `entriesRef`). Test: `leaves a run started before recovery to its own session` in `plugins/dia-runs/run-registry.test.ts`.

## Implication

Recovery that reads stored state after its service is provided must exclude what the service changed since it was provided. `dia-schedules` also waits for `ctx.pluginsSettled` before it fires, so a catch-up run at launch gets the tools of every eager plugin (`dia-tools` loads after `dia-run-queue`). It waits in a fiber forked into the `whenProvided` scope: waiting for `ctx.pluginsSettled` inside the `whenProvided` setup itself failed it with `Plugin "dia-schedules" did not finish its setup within 10s`, because startup settles only after that setup ends.

import {
  type ModelOption,
  ModelsReady,
  type RunInfo,
  type RunStatus,
  type Runs,
  type StartRunOptions,
  type TabPlacement
} from '@dia/plugin'
import type { QueuedRun, RunQueue } from '@dia-plugin/dia-run-queue/queue'
import { DateTime, Deferred, Effect, Option, Stream } from 'effect'
import type { BackendReads } from './run-options'

/** A model option named `value` that supports `auto` when `autoMode` is true. */
export const model = (value: string, autoMode = false): ModelOption => ({
  value,
  displayName: value,
  description: '',
  adaptiveThinking: true,
  effortLevels: [],
  autoMode,
  fastMode: false
})

/** Backend reads whose catalog is ready with `models` and that disable `disabled` everywhere. */
export const fakeBackend = (
  models: readonly [ModelOption, ...Array<ModelOption>],
  disabled: ReadonlyArray<'auto' | 'bypassPermissions'> = []
): BackendReads => ({
  models: () =>
    Stream.make(ModelsReady.make({ models, fetchedAt: DateTime.makeUnsafe(0), refreshing: false })),
  disabledPermissionModes: () => Effect.succeed(disabled)
})

/** One `enqueue` the fake queue holds until the test calls `start`. */
export interface Enqueued {
  readonly entry: QueuedRun
  /** Starts the entry as run `runId`, which `enqueue` then returns. */
  readonly start: (runId: string) => Effect.Effect<void>
}

/**
 * A run service and run queue for tests. `rows` holds the runs `list` reports; `start` and the
 * queue's starts add a live `running` row. `sent`, `closed`, `retired`, `tabs` and `enqueued`
 * record the calls in order.
 */
export const fakeRuns = () => {
  const rows = new Map<string, RunInfo>()
  const sent: Array<{ readonly runId: string; readonly text: string }> = []
  const closed: Array<string> = []
  const retired: Array<string> = []
  const tabs: Array<{ readonly runId: string; readonly placement: TabPlacement | undefined }> = []
  const started: Array<StartRunOptions & { readonly runId: string }> = []
  const enqueued: Array<Enqueued> = []
  let next = 0

  const addRun = (
    runId: string,
    options: Pick<StartRunOptions, 'cwd' | 'model'>,
    state: Pick<RunInfo, 'status' | 'live'> = { status: 'running', live: true }
  ) =>
    rows.set(runId, {
      runId,
      cwd: options.cwd,
      model: options.model,
      thinkingLevel: 'medium',
      permissionMode: 'default',
      sessionId: Option.none(),
      ...state
    })

  /** Stores run `runId` as `list` reports it, with `status` and `live`. */
  const setRun = (runId: string, status: RunStatus, live: boolean) => {
    addRun(runId, { cwd: 'C:/work', model: 'opus' }, { status, live })
  }

  const runs: Pick<Runs, 'list' | 'isLive' | 'send' | 'close' | 'start' | 'retire' | 'openInTab'> =
    {
      list: Effect.sync(() => [...rows.values()]),
      isLive: (runId) => Effect.sync(() => rows.get(runId)?.live === true),
      send: (runId, text) =>
        Effect.sync(() => {
          sent.push({ runId, text })
        }),
      close: (runId) =>
        Effect.sync(() => {
          closed.push(runId)
          const row = rows.get(runId)
          if (row !== undefined) rows.set(runId, { ...row, live: false, status: 'idle' })
        }),
      start: (options) =>
        Effect.sync(() => {
          next += 1
          const runId = `run-${next}`
          addRun(runId, options)
          started.push({ ...options, runId })
          return runId
        }),
      retire: (runId, as) =>
        Effect.sync(() => {
          retired.push(runId)
          const row = rows.get(runId)
          if (row !== undefined && as === 'archived') {
            rows.set(runId, { ...row, live: false, status: 'archived' })
          }
        }),
      openInTab: (runId, placement) =>
        Effect.sync(() => {
          tabs.push({ runId, placement })
        })
    }

  const queue: Pick<RunQueue, 'enqueue'> = {
    enqueue: (entry) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<string>()
        enqueued.push({
          entry,
          start: (runId) =>
            Effect.sync(() => addRun(runId, entry.run)).pipe(
              Effect.andThen(Deferred.succeed(done, runId))
            )
        })
        return yield* Deferred.await(done)
      })
  }

  return { runs, queue, rows, setRun, sent, closed, retired, tabs, started, enqueued }
}

import type { PluginControl, PluginInfo, RunInfo, RunSpec, Runs, TabPlacement } from '@dia/plugin'
import { fakeChoices, model } from '@dia-plugin/dia-agent-definitions/run-settings.fake'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Option } from 'effect'
import { CREATOR_DEFINITION, CREATOR_LABEL } from './creator-definition'
import { CREATOR_TAB_NAME, makeCreatorThreads } from './creator-threads'
import type { TurnChanges, UnmergedRun } from './turn-changes'

const META = 'C:/meta'
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'
const WORKTREE = { path: 'C:/trees/creator', branch: 'dia/creator', sourceRepo: META }

const loaded = (name: string, root: string, status: PluginInfo['status']): PluginInfo => ({
  name,
  category: 'feature',
  origin: 'override',
  root,
  status,
  memoryBytes: 0,
  provides: []
})

interface Options {
  readonly worktree?: typeof WORKTREE | null
  readonly listed?: boolean
  readonly unmerged?: ReadonlyArray<UnmergedRun>
  readonly plugins?: ReadonlyArray<PluginInfo>
  readonly runIds?: ReadonlyArray<string>
}

const threadsWith = (options: Options = {}) => {
  const calls: Array<string> = []
  const opened: Array<RunSpec> = []
  const tabs: Array<TabPlacement | undefined> = []
  const reloaded: Array<string> = []
  const worktree = options.worktree === undefined ? WORKTREE : options.worktree
  const runs: Pick<Runs, 'open' | 'retire' | 'openInTab' | 'send' | 'list'> = {
    list: Effect.succeed((options.runIds ?? [RUN]).map((runId) => ({ runId }) as RunInfo)),
    open: (spec) =>
      Effect.sync(() => {
        opened.push(spec)
        calls.push('open')
        return {
          paneId: spec.runId,
          cwd: worktree?.path ?? spec.sourceCwd,
          model: spec.model,
          backend: spec.backend,
          thinkingLevel: spec.thinkingLevel,
          permissionMode: spec.permissionMode,
          ...(worktree === null ? {} : { worktree })
        }
      }),
    retire: (runId, as) => Effect.sync(() => void calls.push(`retire ${runId} ${as}`)),
    openInTab: (_runId, placement) =>
      Effect.sync(() => {
        tabs.push(placement)
        calls.push('tab')
      }),
    send: (_runId, text) => Effect.sync(() => void calls.push(`send ${text}`))
  }
  const turnChanges: Pick<TurnChanges, 'track' | 'unmerged'> = {
    track: (runId, worktree, lastSequence) =>
      Effect.sync(() => void calls.push(`track ${runId} ${worktree.branch} ${lastSequence}`)),
    unmerged: Effect.succeed(options.unmerged ?? [])
  }
  const plugins: PluginControl = {
    list: Effect.succeed(options.plugins ?? []),
    inspect: () => Effect.die('not used'),
    setOverride: () => Effect.die('not used'),
    reload: (name) =>
      Effect.sync(() => {
        reloaded.push(name)
        return loaded(name, '', { _tag: 'Loaded' })
      })
  }
  const reattachedRuns: Array<string> = []
  const threads = makeCreatorThreads({
    runs,
    runEvents: { highestSequence: Effect.succeed(41) },
    git: { resolveCommit: () => Effect.succeed(Option.some('abc')) },
    metaDirectory: META,
    definitions: {
      list: Effect.succeed(
        options.listed === false
          ? []
          : [
              {
                definition: CREATOR_DEFINITION,
                source: { _tag: 'Plugin', plugin: 'dia-creator' },
                edited: false
              }
            ]
      )
    },
    choices: fakeChoices([model('opus')]),
    gitOps: {
      reattachWorktree: (info, runId) =>
        Effect.sync(() => {
          reattachedRuns.push(runId)
          return info
        })
    },
    plugins,
    turnChanges,
    newRunId: Effect.succeed(RUN)
  })
  return { threads, calls, opened, tabs, reloaded, reattachedRuns }
}

const failureReason = <A>(exit: Exit.Exit<A, { readonly reason: string }>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === 'Fail'
    ? exit.cause.reasons[0].error.reason
    : undefined

describe('makeCreatorThreads', () => {
  it.effect('opens a labelled run in a new meta repo worktree with the Creator definition', () =>
    Effect.gen(function* () {
      const { threads, opened } = threadsWith()

      yield* threads.start('Build a clock plugin')

      const [spec] = opened
      assert.strictEqual(spec?.sourceCwd, META)
      assert.deepStrictEqual(spec?.worktree, { _tag: 'Create', label: 'Creator' })
      assert.deepStrictEqual(spec?.labels, [CREATOR_LABEL])
      assert.strictEqual(spec?.model, 'opus')
      assert.strictEqual(spec?.systemPromptAppend, CREATOR_DEFINITION.jobDescription)
      assert.deepStrictEqual(spec?.permissions, CREATOR_DEFINITION.permissions)
    })
  )

  it.effect('tracks the run and shows its tab under Meta before sending the text', () =>
    Effect.gen(function* () {
      const { threads, calls, tabs } = threadsWith()

      assert.strictEqual(yield* threads.start('Build a clock plugin'), RUN)

      assert.deepStrictEqual(calls, [
        'open',
        `track ${RUN} dia/creator 41`,
        'tab',
        'send Build a clock plugin'
      ])
      assert.deepStrictEqual(tabs[0], {
        projectDirectory: META,
        select: false,
        owner: { plugin: 'dia-creator', ownsProject: true },
        name: CREATOR_TAB_NAME
      })
    })
  )

  it.effect('deletes the run and fails when it opened without a worktree', () =>
    Effect.gen(function* () {
      const { threads, calls } = threadsWith({ worktree: null })

      const exit = yield* Effect.exit(threads.start('Build a clock plugin'))

      assert.strictEqual(failureReason(exit), 'worktree')
      assert.deepStrictEqual(calls, ['open', `retire ${RUN} deleted`])
    })
  )

  it.effect('fails without opening a run when the Creator definition is not listed', () =>
    Effect.gen(function* () {
      const { threads, opened } = threadsWith({ listed: false })

      const exit = yield* Effect.exit(threads.start('Build a clock plugin'))

      assert.strictEqual(failureReason(exit), 'definition-missing')
      assert.deepStrictEqual(opened, [])
    })
  )

  it.effect('reloads only the failed plugins overridden into a reattached worktree', () =>
    Effect.gen(function* () {
      const { threads, reloaded } = threadsWith({
        unmerged: [{ runId: RUN, worktree: WORKTREE }],
        plugins: [
          loaded('clock', 'C:/trees/creator/plugins/clock', { _tag: 'Failed', message: 'missing' }),
          loaded('timer', 'C:/trees/creator/plugins/timer', { _tag: 'Loaded' }),
          loaded('other', 'C:/elsewhere/other', { _tag: 'Failed', message: 'missing' })
        ]
      })

      yield* threads.reattachUnmerged

      assert.deepStrictEqual(reloaded, ['clock'])
    })
  )

  it.effect('does not reattach the worktree of an unmerged thread whose run was deleted', () =>
    Effect.gen(function* () {
      const { threads, reattachedRuns, reloaded } = threadsWith({
        unmerged: [{ runId: RUN, worktree: WORKTREE }],
        runIds: [],
        plugins: [
          loaded('clock', 'C:/trees/creator/plugins/clock', { _tag: 'Failed', message: 'missing' })
        ]
      })

      yield* threads.reattachUnmerged

      assert.deepStrictEqual(reattachedRuns, [])
      assert.deepStrictEqual(reloaded, [])
    })
  )
})

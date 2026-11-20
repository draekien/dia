import {
  AgentEvents,
  Attention,
  type CommittedEvent,
  PaneEvents,
  type PluginControl,
  type PluginInfo,
  type StoredEvent
} from '@dia/plugin'
import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, FileSystem, Path, type Scope } from 'effect'
import { openDatabase } from '../../src/host/services/database'
import { creatorMigrations } from './migrations'
import { makeTurnChanges } from './turn-changes'

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'
const AUTHOR = { name: 'dia', email: 'dia@example.com' }
const BRANCH = 'dia/creator-test'

const loaded = (name: string, root: string, origin: PluginInfo['origin']): PluginInfo => ({
  name,
  category: 'feature',
  origin,
  root,
  status: { _tag: 'Loaded' },
  memoryBytes: 0,
  provides: []
})

const fakePlugins = (list: Array<PluginInfo>) => {
  const reloaded: Array<string> = []
  const overrides: Array<{ readonly name: string; readonly directory: string }> = []
  const plugins: PluginControl = {
    list: Effect.sync(() => [...list]),
    inspect: () => Effect.die('not used'),
    setOverride: (name, directory) =>
      Effect.sync(() => {
        overrides.push({ name, directory })
        return { _tag: 'Applied' } as const
      }),
    reload: (name) =>
      Effect.sync(() => {
        reloaded.push(name)
        return list.find((info) => info.name === name) ?? loaded(name, '', 'default')
      })
  }
  return { plugins, reloaded, overrides }
}

const creatorRepo = (list: Array<PluginInfo> = []) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const git = yield* makeGit
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-creator-' })
    const meta = path.join(root, 'meta')
    const tree = path.join(root, 'tree')
    yield* fs.makeDirectory(path.join(meta, 'plugins', 'hello'), { recursive: true })
    yield* git.init(meta)
    yield* fs.writeFileString(path.join(meta, 'plugins', 'hello', 'host.ts'), 'one\n')
    yield* git.commitAll(meta, { message: 'init', author: AUTHOR })
    yield* git.addWorktree(meta, tree, BRANCH, { createBranch: true })
    yield* Effect.addFinalizer(() =>
      git.stopFsmonitor(meta).pipe(Effect.andThen(git.stopFsmonitor(tree)))
    )
    const worktree = { path: tree, branch: BRANCH, sourceRepo: meta }
    const sql = yield* openDatabase(':memory:', creatorMigrations)
    const fake = fakePlugins(list)
    const changes = yield* makeTurnChanges({
      sql,
      git,
      runEvents: { readTagged: () => Effect.succeed([]) },
      plugins: fake.plugins,
      reattach: (info) => Effect.succeed(info),
      metaDirectory: meta
    })
    yield* changes.track(RUN, worktree, 0)
    let sequence = 0
    const fold = (event: StoredEvent) => {
      sequence += 1
      const committed: CommittedEvent = { runId: RUN, sequence, event }
      return changes.fold(committed).pipe(Effect.as(committed))
    }
    const commit = (content: string, message: string) =>
      fs
        .writeFileString(path.join(tree, 'plugins', 'hello', 'host.ts'), content)
        .pipe(Effect.andThen(git.commitAll(tree, { message, author: AUTHOR })))
    const readHello = (directory: string) =>
      fs
        .readFileString(path.join(directory, 'plugins', 'hello', 'host.ts'))
        .pipe(Effect.map((text) => text.replaceAll('\r\n', '\n')))
    const helloInTree = loaded('hello', path.join(tree, 'plugins', 'hello'), 'override')
    return { git, meta, tree, path, changes, fold, commit, readHello, list, helloInTree, ...fake }
  })

const sent = (id: string) =>
  PaneEvents.PaneUserMessagesSent.make({ paneId: RUN, messages: [{ id, text: 'Build it' }] })

const ended = PaneEvents.PaneAttentionChanged.make({
  paneId: RUN,
  attention: Attention.Completed.make({})
})

const reloadCall = (name: string) =>
  AgentEvents.ToolCallCompleted.make({
    toolCallId: 'call-1',
    toolName: 'mcp__dia__plugin_reload',
    input: { name },
    output: 'loaded',
    isError: false
  })

const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('makeTurnChanges', { timeout: 30_000 }, () => {
  it.live("shows an ended turn's commits oldest first, all unmerged", () =>
    live(
      Effect.gen(function* () {
        const { changes, fold, commit } = yield* creatorRepo()
        yield* fold(sent('m1'))
        yield* commit('two\n', 'feat: two')
        yield* commit('three\n', 'feat: three')
        yield* fold(ended)

        const state = yield* changes.state(RUN)

        assert.deepStrictEqual(
          state.turns.map((turn) => ({
            turnId: turn.turnId,
            ended: turn.ended,
            subjects: turn.commits.map((entry) => entry.subject)
          })),
          [{ turnId: 'm1', ended: true, subjects: ['feat: two', 'feat: three'] }]
        )
        assert.strictEqual(state.unmerged, 2)
      })
    )
  )

  it.live('keeps no turn that made no commit and loaded no plugin', () =>
    live(
      Effect.gen(function* () {
        const { changes, fold } = yield* creatorRepo()
        yield* fold(sent('m1'))
        yield* fold(ended)

        assert.deepStrictEqual((yield* changes.state(RUN)).turns, [])
      })
    )
  )

  it.live('records a plugin a turn reloaded, with its status when the turn ended', () =>
    live(
      Effect.gen(function* () {
        const failed: PluginInfo = {
          ...loaded('hello', 'C:/elsewhere/hello', 'override'),
          status: { _tag: 'Failed', message: 'syntax error' }
        }
        const { changes, fold } = yield* creatorRepo([failed])
        yield* fold(sent('m1'))
        yield* fold(reloadCall('hello'))
        yield* fold(ended)

        const [turn] = (yield* changes.state(RUN)).turns
        assert.deepStrictEqual(turn?.loads, [{ plugin: 'hello', loaded: false }])
      })
    )
  )

  it.live('folds an event only once when it is delivered again', () =>
    live(
      Effect.gen(function* () {
        const { changes, fold, commit } = yield* creatorRepo()
        const start = yield* fold(sent('m1'))
        yield* commit('two\n', 'feat: two')
        yield* fold(ended)
        yield* changes.fold(start)

        const state = yield* changes.state(RUN)
        assert.deepStrictEqual(
          state.turns.map((turn) => [turn.turnId, turn.ended]),
          [['m1', true]]
        )
      })
    )
  )

  it.live("reverts a turn's commits on the branch and reloads the plugin it changed", () =>
    live(
      Effect.gen(function* () {
        const { changes, fold, commit, readHello, reloaded, tree, list, helloInTree } =
          yield* creatorRepo()
        list.push(helloInTree)
        yield* fold(sent('m1'))
        yield* commit('two\n', 'feat: two')
        yield* fold(ended)

        const turn = yield* changes.revert(RUN, 'm1')

        assert.isNotNull(turn.revert)
        assert.strictEqual(yield* readHello(tree), 'one\n')
        assert.deepStrictEqual(reloaded, ['hello'])
        assert.deepStrictEqual(yield* changes.revert(RUN, 'm1'), turn)
      })
    )
  )

  it.live('refuses to revert a turn that has not ended', () =>
    live(
      Effect.gen(function* () {
        const { changes, fold, commit } = yield* creatorRepo()
        yield* fold(sent('m1'))
        yield* commit('two\n', 'feat: two')

        const exit = yield* Effect.exit(changes.revert(RUN, 'm1'))

        assert.deepStrictEqual(
          Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === 'Fail'
            ? exit.cause.reasons[0].error.reason
            : undefined,
          'nothing-to-revert'
        )
      })
    )
  )

  it.live('merges the branch into the meta repo and moves overrides to the meta folder', () =>
    live(
      Effect.gen(function* () {
        const repo = yield* creatorRepo()
        repo.list.push(repo.helloInTree)
        yield* repo.fold(sent('m1'))
        yield* repo.commit('two\n', 'feat: two')
        yield* repo.fold(ended)

        const { sha } = yield* repo.changes.merge(RUN)

        const state = yield* repo.changes.state(RUN)
        assert.strictEqual(state.unmerged, 0)
        assert.deepStrictEqual(state.lastMerge, { sha })
        assert.strictEqual(yield* repo.readHello(repo.meta), 'two\n')
        assert.deepStrictEqual(repo.overrides, [
          { name: 'hello', directory: repo.path.join(repo.meta, 'plugins', 'hello') }
        ])
        assert.include(repo.reloaded, 'hello')
      })
    )
  )

  it.live('refuses to merge a branch the meta repo already has', () =>
    live(
      Effect.gen(function* () {
        const { changes } = yield* creatorRepo()

        const exit = yield* Effect.exit(changes.merge(RUN))

        assert.deepStrictEqual(
          Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === 'Fail'
            ? exit.cause.reasons[0].error.reason
            : undefined,
          'nothing-to-merge'
        )
      })
    )
  )
})

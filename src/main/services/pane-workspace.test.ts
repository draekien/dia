import { FileSystem } from '@effect/platform'
import { NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import type { ConversationMessage } from '@shared/domain/pane'
import type { PaneNode } from '@shared/domain/pane-tree'
import type { IpcEvent } from '@shared/ipc/contract'
import { type Context, Effect, Either, Layer, Option, Stream } from 'effect'
import { WorktreeCreateError } from './git-ops-service'
import { type PaneHandle, PaneSupervisor } from './pane-supervisor'
import { makePaneWorkspaceLive, PaneWorkspace } from './pane-workspace'
import { type PersistedWorkspace, PersistenceService } from './persistence'
import { TranscriptReader } from './transcript-reader'

function secondLeafPaneId(tree: PaneNode): string {
  if (tree._tag !== 'Split') throw new Error('expected a Split')
  const second = tree.children[1]
  if (second._tag !== 'Leaf') throw new Error('expected a Leaf')
  return second.paneId
}

const INITIAL_PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const WORKTREES_ROOT = '/worktrees'

const fakeHandle: PaneHandle = {
  sendMessage: () => Effect.void,
  setThinkingLevel: () => Effect.void,
  resolvePermission: () => Effect.void,
  resolveQuestion: () => Effect.void,
  subscribe: () => Stream.empty,
  markErrored: () => Effect.void
}

function makeSupervisorLayer(
  openPane: Context.Tag.Service<typeof PaneSupervisor>['openPane'],
  getHandle: Context.Tag.Service<typeof PaneSupervisor>['getHandle'] = () =>
    Effect.succeed(Option.none())
): Layer.Layer<PaneSupervisor> {
  return Layer.succeed(PaneSupervisor, {
    openPane,
    closePane: () => Effect.void,
    getHandle,
    closeAll: () => Effect.void
  })
}

function makePersistence(initial?: PersistedWorkspace): {
  readonly saves: Array<PersistedWorkspace>
  readonly layer: Layer.Layer<PersistenceService>
} {
  const saves: Array<PersistedWorkspace> = []
  const layer = Layer.succeed(PersistenceService, {
    loadWorkspace: () => Effect.succeed(Option.fromNullable(initial)),
    saveWorkspace: (workspace) =>
      Effect.sync(() => {
        saves.push(workspace)
      })
  })
  return { saves, layer }
}

function makeTranscriptReader(history: ReadonlyArray<ConversationMessage> = []): {
  readonly reads: Array<{ sessionId: string; cwd: string }>
  readonly layer: Layer.Layer<TranscriptReader>
} {
  const reads: Array<{ sessionId: string; cwd: string }> = []
  const layer = Layer.succeed(TranscriptReader, {
    readHistory: (sessionId, cwd) =>
      Effect.sync(() => {
        reads.push({ sessionId, cwd })
        return history
      })
  })
  return { reads, layer }
}

function makeFileSystemLayer(cwdExists = true): Layer.Layer<FileSystem.FileSystem> {
  return Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({ exists: () => Effect.succeed(cwdExists) })
  )
}

function makeWorkspaceLayer(
  supervisorLayer: Layer.Layer<PaneSupervisor>,
  persistenceLayer: Layer.Layer<PersistenceService>,
  transcriptLayer: Layer.Layer<TranscriptReader> = makeTranscriptReader().layer,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = makeFileSystemLayer()
): Layer.Layer<PaneWorkspace> {
  return Layer.provide(
    makePaneWorkspaceLive(INITIAL_PANE_ID, WORKTREES_ROOT),
    Layer.mergeAll(
      supervisorLayer,
      persistenceLayer,
      transcriptLayer,
      fileSystemLayer,
      NodePath.layer
    )
  )
}

const echoOpenPane = (
  request: Parameters<Context.Tag.Service<typeof PaneSupervisor>['openPane']>[0]
): Effect.Effect<{
  handle: PaneHandle
  config: {
    paneId: string
    cwd: string
    model: string
    thinkingLevel: (typeof request)['thinkingLevel']
  }
}> =>
  Effect.succeed({
    handle: fakeHandle,
    config: {
      paneId: request.paneId,
      cwd: request.sourceCwd,
      model: request.model,
      thinkingLevel: request.thinkingLevel
    }
  })

const onEvent = (_event: IpcEvent): Effect.Effect<void> => Effect.void

describe('PaneWorkspace', () => {
  it.effect('seeds a pending leaf without opening a process when nothing is persisted', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return echoOpenPane(request)
      })
      const { layer: persistenceLayer } = makePersistence()

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        return yield* workspace.getTree()
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(openPaneCalls, 0)
      assert.deepStrictEqual(tree, {
        _tag: 'Leaf',
        paneId: INITIAL_PANE_ID,
        status: 'pending'
      })
    })
  )

  it.effect('hydrates the persisted tree without opening any process', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return echoOpenPane(request)
      })
      const restoredTree: PaneNode = {
        _tag: 'Split',
        direction: 'row',
        children: [
          { _tag: 'Leaf', paneId: INITIAL_PANE_ID, status: 'ready', cwd: '/repo/a' },
          {
            _tag: 'Leaf',
            paneId: 'bbbbbbbb-0000-4000-8000-000000000002',
            status: 'ready',
            cwd: '/wt/b',
            sourceRepo: '/repo'
          }
        ],
        sizes: [0.5, 0.5]
      }
      const { layer: persistenceLayer } = makePersistence({
        tree: restoredTree,
        panes: {
          [INITIAL_PANE_ID]: {
            config: {
              paneId: INITIAL_PANE_ID,
              cwd: '/repo/a',
              model: 'm',
              thinkingLevel: 'adaptive'
            }
          }
        }
      })

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        return yield* workspace.getTree()
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(openPaneCalls, 0)
      assert.deepStrictEqual(tree, restoredTree)
    })
  )

  it.effect('persists the workspace after createPane, recording the pane config', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer(echoOpenPane)
      const { saves, layer: persistenceLayer } = makePersistence()

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'model-x', 'adaptive', false, onEvent)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(saves.length, 1)
      const snapshot = saves[0]
      assert.deepStrictEqual(snapshot.panes[INITIAL_PANE_ID], {
        config: {
          paneId: INITIAL_PANE_ID,
          cwd: '/repo',
          model: 'model-x',
          thinkingLevel: 'adaptive'
        }
      })
      if (snapshot.tree._tag === 'Leaf') {
        assert.strictEqual(snapshot.tree.status, 'ready')
      } else {
        throw new Error('expected a ready leaf')
      }
    })
  )

  it.effect('persists the workspace after split, matching the returned tree', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer(echoOpenPane)
      const { saves, layer: persistenceLayer } = makePersistence()

      const splitTree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', 'adaptive', false, onEvent)
        return yield* workspace.split(INITIAL_PANE_ID, 'row')
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      // createPane saves once, split saves again -> the last snapshot is the split.
      assert.strictEqual(saves.length, 2)
      assert.deepStrictEqual(saves[1].tree, splitTree)
    })
  )

  it.effect('records a sessionId reported after createPane into the index and re-saves', () =>
    Effect.gen(function* () {
      let captured: ((sessionId: string) => Effect.Effect<void>) | undefined
      const supervisorLayer = makeSupervisorLayer((request, _onEvent, onSessionId) => {
        captured = onSessionId
        return echoOpenPane(request)
      })
      const { saves, layer: persistenceLayer } = makePersistence()

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        // createPane registers the pane's index entry and saves once; the session id only
        // arrives afterwards (mirroring the async SystemMessage `init` in production).
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', 'adaptive', false, onEvent)
        if (captured === undefined) throw new Error('onSessionId was not provided to openPane')
        yield* captured('session-async-1')
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(saves.length, 2)
      assert.strictEqual(saves[1].panes[INITIAL_PANE_ID].sessionId, 'session-async-1')
    })
  )

  it.effect('preserves a restored pane sessionId across a later save', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer(echoOpenPane)
      const { saves, layer: persistenceLayer } = makePersistence({
        tree: { _tag: 'Leaf', paneId: INITIAL_PANE_ID, status: 'ready', cwd: '/repo' },
        panes: {
          [INITIAL_PANE_ID]: {
            config: {
              paneId: INITIAL_PANE_ID,
              cwd: '/repo',
              model: 'm',
              thinkingLevel: 'adaptive'
            },
            sessionId: 'restored-session-1'
          }
        }
      })

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.split(INITIAL_PANE_ID, 'column')
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(saves.length, 1)
      assert.strictEqual(saves[0].panes[INITIAL_PANE_ID].sessionId, 'restored-session-1')
    })
  )

  it.effect('split creates a pending leaf without opening a process', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return echoOpenPane(request)
      })
      const { layer: persistenceLayer } = makePersistence()

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', 'adaptive', false, onEvent)
        return yield* workspace.split(INITIAL_PANE_ID, 'row')
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      // Only the initial createPane call should have opened a process; split itself must not.
      assert.strictEqual(openPaneCalls, 1)
      assert.deepStrictEqual(tree, {
        _tag: 'Split',
        direction: 'row',
        children: [
          {
            _tag: 'Leaf',
            paneId: INITIAL_PANE_ID,
            status: 'ready',
            cwd: '/repo',
            sourceRepo: undefined,
            thinkingLevel: 'adaptive'
          },
          { _tag: 'Leaf', paneId: secondLeafPaneId(tree), status: 'pending' }
        ],
        sizes: [0.5, 0.5]
      })
    })
  )

  it.effect('createPane flips a pending leaf to ready on success', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer(echoOpenPane)
      const { layer: persistenceLayer } = makePersistence()

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', 'adaptive', false, onEvent)
        const split = yield* workspace.split(INITIAL_PANE_ID, 'row')
        const newPaneId = secondLeafPaneId(split)
        return yield* workspace.createPane(newPaneId, '/other', 'm', 'adaptive', false, onEvent)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.isTrue(tree._tag === 'Split')
      if (tree._tag === 'Split') {
        assert.deepStrictEqual(
          tree.children.map((child) => (child._tag === 'Leaf' ? child.status : child._tag)),
          ['ready', 'ready']
        )
      }
    })
  )

  it.effect('createPane propagates a WorktreeCreateError and leaves the leaf pending', () =>
    Effect.gen(function* () {
      const error = new WorktreeCreateError({
        paneId: 'bbbbbbbb-0000-4000-8000-000000000002',
        sourceRepo: '/other',
        cause: 'boom'
      })
      const supervisorLayer = makeSupervisorLayer((request) =>
        request.paneId === INITIAL_PANE_ID ? echoOpenPane(request) : Effect.fail(error)
      )
      const { layer: persistenceLayer } = makePersistence()

      const result = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', 'adaptive', false, onEvent)
        const split = yield* workspace.split(INITIAL_PANE_ID, 'row')
        const newPaneId = secondLeafPaneId(split)
        return yield* workspace
          .createPane(newPaneId, '/other', 'm', 'adaptive', true, onEvent)
          .pipe(Effect.either)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.isTrue(Either.isLeft(result))
      if (Either.isLeft(result)) {
        assert.instanceOf(result.left, WorktreeCreateError)
      }
    })
  )

  it.effect('closing the last remaining pane resets it to a pending leaf', () =>
    Effect.gen(function* () {
      let closePaneCalls = 0
      const supervisorLayer = Layer.succeed(PaneSupervisor, {
        openPane: echoOpenPane,
        closePane: () => {
          closePaneCalls++
          return Effect.void
        },
        getHandle: () => Effect.succeed(Option.none()),
        closeAll: () => Effect.void
      })
      const { saves, layer: persistenceLayer } = makePersistence()

      const tree = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', 'adaptive', false, onEvent)
        return yield* workspace.close(INITIAL_PANE_ID)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(closePaneCalls, 1)
      assert.deepStrictEqual(tree, {
        _tag: 'Leaf',
        paneId: INITIAL_PANE_ID,
        status: 'pending'
      })
      // createPane saved once, close saved again with the pane removed from the index.
      assert.strictEqual(saves.length, 2)
      assert.deepStrictEqual(saves[1].panes, {})
    })
  )

  it.effect(
    'getPaneHistory returns empty without reading a transcript when no session is recorded',
    () =>
      Effect.gen(function* () {
        const supervisorLayer = makeSupervisorLayer(echoOpenPane)
        const { layer: persistenceLayer } = makePersistence()
        const { reads, layer: transcriptLayer } = makeTranscriptReader([
          { role: 'user', content: 'x' }
        ])

        const history = yield* Effect.gen(function* () {
          const workspace = yield* PaneWorkspace
          yield* workspace.createPane(INITIAL_PANE_ID, '/repo', 'm', 'adaptive', false, onEvent)
          return yield* workspace.getPaneHistory(INITIAL_PANE_ID)
        }).pipe(
          Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer, transcriptLayer))
        )

        assert.deepStrictEqual(history, [])
        assert.strictEqual(reads.length, 0)
      })
  )

  it.effect('getPaneHistory reads the transcript by the restored pane sessionId and cwd', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer(echoOpenPane)
      const { layer: persistenceLayer } = makePersistence({
        tree: { _tag: 'Leaf', paneId: INITIAL_PANE_ID, status: 'ready', cwd: '/repo' },
        panes: {
          [INITIAL_PANE_ID]: {
            config: {
              paneId: INITIAL_PANE_ID,
              cwd: '/repo',
              model: 'm',
              thinkingLevel: 'adaptive'
            },
            sessionId: 'restored-session-1'
          }
        }
      })
      const restored: ReadonlyArray<ConversationMessage> = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' }
      ]
      const { reads, layer: transcriptLayer } = makeTranscriptReader(restored)

      const history = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        return yield* workspace.getPaneHistory(INITIAL_PANE_ID)
      }).pipe(
        Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer, transcriptLayer))
      )

      assert.deepStrictEqual(history, restored)
      assert.deepStrictEqual(reads, [{ sessionId: 'restored-session-1', cwd: '/repo' }])
    })
  )

  const restoredWithSession: PersistedWorkspace = {
    tree: { _tag: 'Leaf', paneId: INITIAL_PANE_ID, status: 'ready', cwd: '/repo' },
    panes: {
      [INITIAL_PANE_ID]: {
        config: { paneId: INITIAL_PANE_ID, cwd: '/repo', model: 'm', thinkingLevel: 'adaptive' },
        sessionId: 'restored-session-1'
      }
    }
  }

  function recordEvents(): {
    readonly events: Array<IpcEvent>
    readonly onEvent: (event: IpcEvent) => Effect.Effect<void>
  } {
    const events: Array<IpcEvent> = []
    return { events, onEvent: (event) => Effect.sync(() => events.push(event)) }
  }

  it.effect('resumePane opens the cold pane with its recorded sessionId threaded through', () =>
    Effect.gen(function* () {
      const requests: Array<Parameters<Context.Tag.Service<typeof PaneSupervisor>['openPane']>[0]> =
        []
      const supervisorLayer = makeSupervisorLayer((request) => {
        requests.push(request)
        return echoOpenPane(request)
      })
      const { layer: persistenceLayer } = makePersistence(restoredWithSession)
      const { events, onEvent: recordingOnEvent } = recordEvents()

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.resumePane(INITIAL_PANE_ID, recordingOnEvent)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].resume, 'restored-session-1')
      assert.strictEqual(requests[0].sourceCwd, '/repo')
      assert.strictEqual(requests[0].worktreePath, undefined)
      assert.deepStrictEqual(events, [])
    })
  )

  it.effect('resumePane is a no-op when the pane already has a live handle', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer(
        (request) => {
          openPaneCalls++
          return echoOpenPane(request)
        },
        () => Effect.succeed(Option.some(fakeHandle))
      )
      const { layer: persistenceLayer } = makePersistence(restoredWithSession)
      const { events, onEvent: recordingOnEvent } = recordEvents()

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.resumePane(INITIAL_PANE_ID, recordingOnEvent)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(openPaneCalls, 0)
      assert.deepStrictEqual(events, [])
    })
  )

  it.effect('resumePane is a no-op when the pane has no recorded session', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return echoOpenPane(request)
      })
      const { layer: persistenceLayer } = makePersistence({
        tree: { _tag: 'Leaf', paneId: INITIAL_PANE_ID, status: 'ready', cwd: '/repo' },
        panes: {
          [INITIAL_PANE_ID]: {
            config: { paneId: INITIAL_PANE_ID, cwd: '/repo', model: 'm', thinkingLevel: 'adaptive' }
          }
        }
      })
      const { events, onEvent: recordingOnEvent } = recordEvents()

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.resumePane(INITIAL_PANE_ID, recordingOnEvent)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.strictEqual(openPaneCalls, 0)
      assert.deepStrictEqual(events, [])
    })
  )

  it.effect('resumePane emits Errored without opening when a non-worktree cwd is gone', () =>
    Effect.gen(function* () {
      let openPaneCalls = 0
      const supervisorLayer = makeSupervisorLayer((request) => {
        openPaneCalls++
        return echoOpenPane(request)
      })
      const { layer: persistenceLayer } = makePersistence(restoredWithSession)
      const { events, onEvent: recordingOnEvent } = recordEvents()

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.resumePane(INITIAL_PANE_ID, recordingOnEvent)
      }).pipe(
        Effect.provide(
          makeWorkspaceLayer(
            supervisorLayer,
            persistenceLayer,
            makeTranscriptReader().layer,
            makeFileSystemLayer(false)
          )
        )
      )

      assert.strictEqual(openPaneCalls, 0)
      assert.strictEqual(events.length, 1)
      const event = events[0]
      assert.strictEqual(event._tag, 'PaneAttentionChanged')
      if (event._tag === 'PaneAttentionChanged') {
        assert.strictEqual(event.attention._tag, 'Errored')
      }
    })
  )

  it.effect('resumePane reattaches a worktree pane and skips the cwd existence check', () =>
    Effect.gen(function* () {
      const requests: Array<Parameters<Context.Tag.Service<typeof PaneSupervisor>['openPane']>[0]> =
        []
      const supervisorLayer = makeSupervisorLayer((request) => {
        requests.push(request)
        return echoOpenPane(request)
      })
      const { layer: persistenceLayer } = makePersistence({
        tree: {
          _tag: 'Leaf',
          paneId: INITIAL_PANE_ID,
          status: 'ready',
          cwd: '/wt/x',
          sourceRepo: '/repo'
        },
        panes: {
          [INITIAL_PANE_ID]: {
            config: {
              paneId: INITIAL_PANE_ID,
              cwd: '/wt/x',
              model: 'm',
              thinkingLevel: 'adaptive',
              worktree: { path: '/wt/x', branch: `dia/${INITIAL_PANE_ID}`, sourceRepo: '/repo' }
            },
            sessionId: 'restored-session-1'
          }
        }
      })
      const { events, onEvent: recordingOnEvent } = recordEvents()

      yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        yield* workspace.resumePane(INITIAL_PANE_ID, recordingOnEvent)
      }).pipe(
        Effect.provide(
          makeWorkspaceLayer(
            supervisorLayer,
            persistenceLayer,
            makeTranscriptReader().layer,
            makeFileSystemLayer(false)
          )
        )
      )

      assert.strictEqual(requests.length, 1)
      assert.strictEqual(requests[0].worktreePath, '/wt/x')
      assert.strictEqual(requests[0].sourceCwd, '/repo')
      assert.strictEqual(requests[0].resume, 'restored-session-1')
      assert.deepStrictEqual(events, [])
    })
  )

  it.effect('resumePane emits Errored when the supervisor fails to open the pane', () =>
    Effect.gen(function* () {
      const supervisorLayer = makeSupervisorLayer((request) =>
        Effect.fail(
          new WorktreeCreateError({ paneId: request.paneId, sourceRepo: '/repo', cause: 'boom' })
        )
      )
      const { layer: persistenceLayer } = makePersistence(restoredWithSession)
      const { events, onEvent: recordingOnEvent } = recordEvents()

      const result = yield* Effect.gen(function* () {
        const workspace = yield* PaneWorkspace
        return yield* workspace.resumePane(INITIAL_PANE_ID, recordingOnEvent).pipe(Effect.either)
      }).pipe(Effect.provide(makeWorkspaceLayer(supervisorLayer, persistenceLayer)))

      assert.isTrue(Either.isRight(result))
      assert.strictEqual(events.length, 1)
      const event = events[0]
      assert.strictEqual(event._tag, 'PaneAttentionChanged')
      if (event._tag === 'PaneAttentionChanged') {
        assert.strictEqual(event.attention._tag, 'Errored')
      }
    })
  )
})

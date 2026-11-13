import { NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { NoActivity, StatusIdle } from '@shared/domain/agent-summary'
import type { SendMode } from '@shared/domain/message-queue'
import { emptyPaneChatState } from '@shared/domain/pane-chat'
import {
  AgentName,
  DirectoryNotFoundError,
  EMPTY_WORKSPACE,
  ProjectId,
  ProjectNotFoundError,
  TabNotFoundError,
  WorktreeNotRemovedError
} from '@shared/domain/project'
import { AgentItem, ProjectRemoved, Removed } from '@shared/domain/project-removal'
import type { TranscriptWidth } from '@shared/domain/transcript-width'
import {
  CreateTab,
  type IpcEvent,
  MoveProject,
  type PaneCreateFailed,
  RenameTab,
  SelectTab,
  SetTranscriptWidth
} from '@shared/ipc/contract'
import type { PluginServices } from '@shared/plugin/api'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { fakeUse } from '@shared/plugin/plugin-registry.fake'
import { Effect, FileSystem, Layer, Option, Schema, Stream } from 'effect'
import { Rpc } from 'effect/rpc'
import { HostPlugins } from '../plugins/host-plugins'
import { servePluginCall } from '../plugins/plugin-messages'
import { InvalidOverrideError, PluginSources } from '../plugins/plugin-sources'
import { AgentSummaries } from '../services/agent-summaries'
import { BackgroundActivities } from '../services/background-activities'
import { type CommandDeduper, makeCommandDeduperLive } from '../services/command-deduper'
import { EventHub } from '../services/event-hub'
import { PaneWorkspace } from '../services/pane-workspace'
import { ProjectEntries } from '../services/project-entries'
import { RunEventLog } from '../services/run-event-log'
import { SettingsStore } from '../services/settings-store'
import { WorkspaceProblems } from '../services/workspace-problems'
import { makeDiaRpcHandlers } from './rpc-handlers'

const PANE_ID = '00000000-0000-4000-8000-00000000000a'
const OTHER_PANE_ID = '00000000-0000-4000-8000-00000000000b'
const STUCK_PANE_ID = '00000000-0000-4000-8000-00000000000c'
const PROJECT_ID = ProjectId.make('00000000-0000-4000-8000-0000000000aa')

interface Harness {
  readonly calls: Array<string>
  readonly published: Array<IpcEvent>
  readonly layer: Layer.Layer<
    | PaneWorkspace
    | AgentSummaries
    | SettingsStore
    | EventHub
    | FileSystem.FileSystem
    | CommandDeduper
    | HostPlugins
    | PluginSources
    | BackgroundActivities
    | WorkspaceProblems
    | RunEventLog
  >
}

interface HarnessOptions {
  readonly createTabFails?: boolean
  readonly storedSendMode?: SendMode
  readonly storedTranscriptWidth?: TranscriptWidth
  readonly pluginUse?: PluginRegistry['use']
}

const createTab = (commandId = 'req-1') => ({
  ...CreateTab.make({
    projectId: PROJECT_ID,
    paneId: PANE_ID,
    name: AgentName.make('heron'),
    model: 'sonnet',
    thinkingLevel: 'high',
    permissionMode: 'acceptEdits',
    useWorktree: true
  }),
  commandId
})

const makeHarness = (options: HarnessOptions = {}): Harness => {
  const calls: Array<string> = []
  const published: Array<IpcEvent> = []

  const retire = (operation: string, paneId: string) =>
    paneId === STUCK_PANE_ID
      ? Effect.fail(
          new WorktreeNotRemovedError({ paneId, path: '/worktrees/stuck', reason: 'locked' })
        )
      : paneId === PANE_ID
        ? Effect.sync(() => void calls.push(`${operation}:${paneId}`))
        : Effect.fail(new TabNotFoundError({ paneId }))

  const workspace = Layer.succeed(PaneWorkspace, {
    getWorkspace: Effect.succeed(EMPTY_WORKSPACE),
    registerProject: (projectId, directory) =>
      directory === '/missing'
        ? Effect.fail(new DirectoryNotFoundError({ directory }))
        : Effect.sync(() => void calls.push(`registerProject:${projectId}:${directory}`)),
    importTab: () => Effect.die(new Error('importTab not used by these tests')),
    moveProject: (projectId, toIndex) =>
      Effect.sync(() => void calls.push(`moveProject:${projectId}:${toIndex}`)),
    removeProject: (projectId, force) =>
      projectId === PROJECT_ID
        ? Stream.fromIterable([
            Removed.make({
              item: AgentItem.make({
                paneId: PANE_ID,
                name: AgentName.make(force ? 'forced' : 'heron')
              })
            }),
            ProjectRemoved.make({})
          ])
        : Stream.fail(new ProjectNotFoundError({ projectId })),
    createTab: (request) =>
      options.createTabFails
        ? Effect.fail(new ProjectNotFoundError({ projectId: request.projectId }))
        : Effect.sync(() => void calls.push(`createTab:${JSON.stringify(request)}`)),
    renameTab: (paneId, name) => Effect.sync(() => void calls.push(`renameTab:${paneId}:${name}`)),
    archiveTab: (paneId) => retire('archiveTab', paneId),
    deleteTab: (paneId) => retire('deleteTab', paneId),
    unarchiveTab: (paneId) =>
      paneId === OTHER_PANE_ID
        ? Effect.fail(new TabNotFoundError({ paneId }))
        : Effect.sync(() => void calls.push(`unarchiveTab:${paneId}`)),
    selectTab: (paneId) => Effect.sync(() => void calls.push(`selectTab:${paneId ?? 'none'}`)),
    setThinkingLevel: () => Effect.void,
    setPermissionMode: () => Effect.void,
    setModel: (paneId, model) => Effect.sync(() => void calls.push(`setModel:${paneId}:${model}`)),
    resumePane: () => Effect.void
  })

  const summaries = Layer.succeed(AgentSummaries, {
    getAll: Effect.succeed([
      { paneId: PANE_ID, status: StatusIdle.make({}), activity: NoActivity.make({}) }
    ])
  })

  const settings = Layer.succeed(SettingsStore, {
    getAdapterPreferences: () => Effect.succeed({ models: {}, defaults: {} }),
    setAdapterPreferences: () => Effect.void,
    getTheme: () => Effect.succeed(Option.none()),
    setTheme: () => Effect.void,
    getSendMode: () => Effect.succeed(Option.fromNullishOr(options.storedSendMode)),
    setSendMode: (mode) =>
      Effect.sync(() => {
        calls.push(`setSendMode:${mode}`)
      }),
    getTranscriptWidth: () => Effect.succeed(Option.fromNullishOr(options.storedTranscriptWidth)),
    setTranscriptWidth: (width) =>
      Effect.sync(() => {
        calls.push(`setTranscriptWidth:${width}`)
      }),
    getUsageLimitResume: () => Effect.succeed(Option.none()),
    setUsageLimitResume: (mode) =>
      Effect.sync(() => {
        calls.push(`settings.setUsageLimitResume:${mode}`)
      }),
    getPluginOverrides: () => Effect.succeed({}),
    setPluginOverride: () => Effect.void,
    clearPluginOverride: () => Effect.void
  })

  const pluginInfo = (name: string) => ({
    name,
    category: 'feature' as const,
    origin: 'default' as const,
    root: `plugins/${name}`,
    status: { _tag: 'Loaded' as const },
    memoryBytes: 0,
    provides: []
  })

  const plugins = Layer.succeed(HostPlugins, {
    list: () => Effect.succeed([pluginInfo('chat')]),
    start: () => Effect.void,
    inject: () => Effect.succeed(Option.none()),
    use: options.pluginUse ?? (() => Effect.succeedNone),
    changes: Stream.empty,
    load: (name) =>
      Effect.sync(() => {
        calls.push(`loadPlugin:${name}`)
        return pluginInfo(name)
      }),
    unload: (name) =>
      Effect.sync(() => {
        calls.push(`unloadPlugin:${name}`)
        return { ...pluginInfo(name), status: { _tag: 'Unloaded' as const } }
      })
  })

  const pluginSources = Layer.succeed(PluginSources, {
    names: () => Effect.succeed(['chat']),
    resolve: () => Effect.succeed(Option.none()),
    setOverride: (name, directory) =>
      directory === '/not-a-plugin'
        ? Effect.fail(new InvalidOverrideError({ message: 'no plugin.json' }))
        : Effect.sync(() => {
            calls.push(`setOverride:${name}:${directory}`)
          }),
    clearOverride: (name) =>
      Effect.sync(() => {
        calls.push(`clearOverride:${name}`)
      })
  })

  const activities = Layer.succeed(BackgroundActivities, {
    register: () => Effect.die(new Error('register not used by these tests')),
    list: Effect.succeed([]),
    runNow: (plugin, id) =>
      Effect.sync(() => {
        calls.push(`runActivity:${plugin}:${id}`)
      })
  })

  const problems = Layer.succeed(WorkspaceProblems, {
    list: Effect.succeed([]),
    deleteUnreadable: (row) =>
      Effect.sync(() => void calls.push(`deleteUnreadable:${row.kind}:${row.id}`)),
    resolveImportConflict: (agentId, resolution) =>
      Effect.sync(() => void calls.push(`resolveImportConflict:${agentId}:${resolution}`))
  })

  const paneChats = Layer.succeed(RunEventLog, {
    snapshot: (paneId: string) =>
      Effect.sync(() => {
        calls.push(`snapshot:${paneId}`)
        return { state: emptyPaneChatState, seq: 7 }
      }),
    seed: () => Effect.void,
    release: () => Effect.void
  } as unknown as RunEventLog['Service'])

  const hub = Layer.succeed(EventHub, {
    publish: (event) =>
      Effect.sync(() => {
        published.push(event)
      }),
    subscribe: () => Stream.empty
  })

  return {
    calls,
    published,
    layer: Layer.mergeAll(
      workspace,
      summaries,
      settings,
      hub,
      FileSystem.layerNoop({}),
      makeCommandDeduperLive(),
      plugins,
      pluginSources,
      activities,
      problems,
      paneChats
    )
  }
}

const withHandlers = <A, E>(
  harness: Harness,
  use: (handlers: Effect.Success<typeof makeDiaRpcHandlers>) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const handlers = yield* makeDiaRpcHandlers
    return yield* use(handlers)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        harness.layer,
        NodePath.layer,
        Layer.succeed(ProjectEntries, { list: () => Effect.succeed([]) })
      )
    )
  )

describe('Dia RPC handlers', () => {
  it.effect('delivers the pane id and model of a SetModel unchanged, once per commandId', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) =>
        Effect.gen(function* () {
          const command = {
            _tag: 'SetModel' as const,
            paneId: PANE_ID,
            model: 'claude-opus-5',
            commandId: 'req-1'
          }
          yield* handlers.SetModel(command)
          yield* handlers.SetModel(command)
        })
      )

      assert.deepStrictEqual(
        harness.calls.filter((call) => call.startsWith('setModel')),
        [`setModel:${PANE_ID}:claude-opus-5`]
      )
    })
  )

  it.effect('delivers every CreateTab payload field to the workspace unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) => handlers.CreateTab(createTab()))

      assert.deepStrictEqual(harness.calls, [
        `createTab:${JSON.stringify({
          projectId: PROJECT_ID,
          paneId: PANE_ID,
          name: 'heron',
          model: 'sonnet',
          thinkingLevel: 'high',
          permissionMode: 'acceptEdits',
          useWorktree: true
        })}`
      ])
    })
  )

  it.effect('applies a CreateTab once when the client resends it with the same commandId', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) =>
        Effect.gen(function* () {
          yield* handlers.CreateTab(createTab())
          yield* handlers.CreateTab(createTab())
        })
      )

      assert.strictEqual(harness.calls.length, 1)
    })
  )

  it.effect('publishes PaneCreateFailed when CreateTab fails', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ createTabFails: true })

      yield* withHandlers(harness, (handlers) => handlers.CreateTab(createTab()))

      assert.strictEqual(harness.published.length, 1)
      const event = harness.published[0]
      assert.isTrue(event._tag === 'PaneCreateFailed')
      assert.strictEqual((event as PaneCreateFailed).paneId, PANE_ID)
    })
  )

  it.effect('delivers the project id and index of a MoveProject unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) =>
        handlers.MoveProject({
          ...MoveProject.make({ projectId: PROJECT_ID, toIndex: 2 }),
          commandId: 'c-1'
        })
      )

      assert.deepStrictEqual(harness.calls, [`moveProject:${PROJECT_ID}:2`])
    })
  )

  it.effect('delivers the pane id and name of a RenameTab unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) =>
        handlers.RenameTab({
          ...RenameTab.make({ paneId: PANE_ID, name: AgentName.make('quiet-heron') }),
          commandId: 'c-1'
        })
      )

      assert.deepStrictEqual(harness.calls, [`renameTab:${PANE_ID}:quiet-heron`])
    })
  )

  it.effect('delivers the pane id of a SelectTab, and no tab for none, unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) =>
        Effect.gen(function* () {
          yield* handlers.SelectTab({
            ...SelectTab.make({ paneId: PANE_ID }),
            commandId: 'c-1'
          })
          yield* handlers.SelectTab({
            ...SelectTab.make({ paneId: null }),
            commandId: 'c-2'
          })
        })
      )

      assert.deepStrictEqual(harness.calls, [`selectTab:${PANE_ID}`, 'selectTab:none'])
    })
  )

  it.effect('stores the width of a SetTranscriptWidth once per commandId', () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      const command = { ...SetTranscriptWidth.make({ width: 'wide' }), commandId: 'c-1' }

      yield* withHandlers(harness, (handlers) =>
        Effect.gen(function* () {
          yield* handlers.SetTranscriptWidth(command)
          yield* handlers.SetTranscriptWidth(command)
        })
      )

      assert.deepStrictEqual(harness.calls, ['setTranscriptWidth:wide'])
    })
  )

  it.effect('reports the default transcript width when none is stored', () =>
    Effect.gen(function* () {
      const width = yield* withHandlers(makeHarness(), (handlers) => handlers.GetTranscriptWidth())

      assert.strictEqual(width, 'default')
    })
  )

  it.effect('returns the reason RegisterProject refused a directory as a typed error', () =>
    Effect.gen(function* () {
      const error = yield* withHandlers(makeHarness(), (handlers) =>
        Effect.flip(handlers.RegisterProject({ projectId: PROJECT_ID, directory: '/missing' }))
      )

      assert.strictEqual(error._tag, 'DirectoryNotFoundError')
    })
  )

  it.effect('delivers the pane id of an ArchiveTab and a DeleteTab unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      yield* withHandlers(harness, (handlers) =>
        Effect.all([
          handlers.ArchiveTab({ paneId: PANE_ID }),
          handlers.DeleteTab({ paneId: PANE_ID })
        ])
      )

      assert.deepStrictEqual(harness.calls, [`archiveTab:${PANE_ID}`, `deleteTab:${PANE_ID}`])
    })
  )

  it.effect(
    'delivers the row of a DeleteUnreadableRow and the conflict of a ResolveImportConflict unchanged',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness()
        yield* withHandlers(harness, (handlers) =>
          Effect.all([
            handlers.DeleteUnreadableRow({ kind: 'agent', id: PANE_ID }),
            handlers.ResolveImportConflict({ agentId: OTHER_PANE_ID, resolution: 'discard' })
          ])
        )

        assert.deepStrictEqual(harness.calls, [
          `deleteUnreadable:agent:${PANE_ID}`,
          `resolveImportConflict:${OTHER_PANE_ID}:discard`
        ])
      })
  )

  it.effect('delivers the pane id of an UnarchiveTab unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness()
      yield* withHandlers(harness, (handlers) => handlers.UnarchiveTab({ paneId: PANE_ID }))

      assert.deepStrictEqual(harness.calls, [`unarchiveTab:${PANE_ID}`])
    })
  )

  it.effect('succeeds an UnarchiveTab for a tab that is already gone', () =>
    Effect.gen(function* () {
      const result = yield* withHandlers(makeHarness(), (handlers) =>
        Effect.result(handlers.UnarchiveTab({ paneId: OTHER_PANE_ID }))
      )

      assert.strictEqual(result._tag, 'Success')
    })
  )

  it.effect('succeeds an ArchiveTab and a DeleteTab for a tab that is already gone', () =>
    Effect.gen(function* () {
      const results = yield* withHandlers(makeHarness(), (handlers) =>
        Effect.all([
          Effect.result(handlers.ArchiveTab({ paneId: OTHER_PANE_ID })),
          Effect.result(handlers.DeleteTab({ paneId: OTHER_PANE_ID }))
        ])
      )

      assert.isTrue(results.every((result) => result._tag === 'Success'))
    })
  )

  it.effect('returns a worktree that DeleteTab could not remove as a typed error', () =>
    Effect.gen(function* () {
      const error = yield* withHandlers(makeHarness(), (handlers) =>
        Effect.flip(handlers.DeleteTab({ paneId: STUCK_PANE_ID }))
      )

      assert.deepStrictEqual(
        [error._tag, error.path, error.reason],
        ['WorktreeNotRemovedError', '/worktrees/stuck', 'locked']
      )
    })
  )

  it.effect('streams the removal progress of RemoveProject with its force flag', () =>
    Effect.gen(function* () {
      const progress = yield* withHandlers(makeHarness(), (handlers) =>
        Stream.runCollect(handlers.RemoveProject({ projectId: PROJECT_ID, force: true }))
      )

      assert.deepStrictEqual(progress, [
        Removed.make({
          item: AgentItem.make({ paneId: PANE_ID, name: AgentName.make('forced') })
        }),
        ProjectRemoved.make({})
      ])
    })
  )

  it.effect('returns the agent summaries the Host holds', () =>
    Effect.gen(function* () {
      const all = yield* withHandlers(makeHarness(), (handlers) => handlers.GetAgentSummaries())

      assert.deepStrictEqual(
        all.map((summary) => summary.paneId),
        [PANE_ID]
      )
    })
  )

  it.effect(
    'forwards LoadPlugin and UnloadPlugin to the plugin registry with the plugin name',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness()

        const result = yield* withHandlers(harness, (handlers) =>
          Effect.gen(function* () {
            const loaded = yield* handlers.LoadPlugin({ name: 'chat' })
            const unloaded = yield* handlers.UnloadPlugin({ name: 'chat' })
            return [loaded.status._tag, unloaded.status._tag]
          })
        )

        assert.deepStrictEqual(result, ['Loaded', 'Unloaded'])
        assert.deepStrictEqual(harness.calls, ['loadPlugin:chat', 'unloadPlugin:chat'])
      })
  )

  it.effect('passes the RunActivity plugin and id to the background activities unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) =>
        handlers.RunActivity({ plugin: 'claude-code', id: 'models' })
      )

      assert.deepStrictEqual(harness.calls, ['runActivity:claude-code:models'])
    })
  )

  it.effect('reports an override the sources refuse as Rejected with the reason', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const result = yield* withHandlers(harness, (handlers) =>
        Effect.gen(function* () {
          const applied = yield* handlers.SetPluginOverride({
            name: 'chat',
            directory: '/tree/chat'
          })
          const rejected = yield* handlers.SetPluginOverride({
            name: 'chat',
            directory: '/not-a-plugin'
          })
          return [applied, rejected]
        })
      )

      assert.deepStrictEqual(result, [
        { _tag: 'Applied' },
        { _tag: 'Rejected', message: 'no plugin.json' }
      ])
      assert.deepStrictEqual(harness.calls, ['setOverride:chat:/tree/chat'])
    })
  )

  it.effect('clears a plugin override through the sources', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) => handlers.ClearPluginOverride({ name: 'chat' }))

      assert.deepStrictEqual(harness.calls, ['clearOverride:chat'])
    })
  )

  it.effect('serves the chat snapshot of the pane named in a GetPaneChat payload', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const snapshot = yield* withHandlers(harness, (handlers) =>
        handlers.GetPaneChat({ paneId: OTHER_PANE_ID })
      )

      assert.deepStrictEqual(harness.calls, [`snapshot:${OTHER_PANE_ID}`])
      assert.strictEqual(snapshot.seq, 7)
    })
  )

  it.effect('reports queue as the send mode when none is stored', () =>
    Effect.gen(function* () {
      const mode = yield* withHandlers(makeHarness(), (handlers) => handlers.GetSendMode())

      assert.strictEqual(mode, 'queue')
    })
  )

  it.effect('reports the stored send mode and stores a new one', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ storedSendMode: 'steer' })

      const mode = yield* withHandlers(harness, (handlers) =>
        handlers.GetSendMode().pipe(Effect.tap(handlers.SetSendMode({ mode: 'queue' })))
      )

      assert.strictEqual(mode, 'steer')
      assert.deepStrictEqual(harness.calls, ['setSendMode:queue'])
    })
  )

  it.effect(
    'hands a SubscribePlugin handler the call payload, including its own payload field, unchanged',
    () =>
      Effect.gen(function* () {
        const Ticks = Rpc.make('Ticks', {
          payload: { payload: Schema.Number },
          success: Schema.Number,
          stream: true
        })
        const provided = new Map<string, unknown>()
        const received: Array<unknown> = []
        yield* servePluginCall(
          {
            name: 'example',
            provide: (key: unknown, value: unknown) =>
              Effect.sync(() => void provided.set(String(key), value))
          } as unknown as PluginServices,
          new Set(),
          Ticks,
          (payload: { readonly payload: number }) => {
            received.push({ ...payload })
            return Stream.make(1)
          }
        )
        const harness = makeHarness({
          pluginUse: fakeUse((key) => Option.fromNullishOr(provided.get(key)))
        })

        const values = yield* withHandlers(harness, (handlers) =>
          Stream.runCollect(
            handlers.SubscribePlugin({
              plugin: 'example',
              tag: 'Ticks',
              payload: { payload: 1 }
            }) as Stream.Stream<unknown, unknown>
          )
        )

        assert.deepStrictEqual(received, [{ payload: 1 }])
        assert.deepStrictEqual(values, [1])
      }).pipe(Effect.scoped)
  )
})

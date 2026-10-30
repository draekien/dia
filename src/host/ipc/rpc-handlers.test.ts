import { NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { NoActivity, StatusIdle } from '@shared/domain/agent-summary'
import { Deny, FreeformResponse } from '@shared/domain/attention'
import type { SendMode } from '@shared/domain/message-queue'
import { LastVisibleModel } from '@shared/domain/model-preferences'
import {
  AgentName,
  DirectoryNotFoundError,
  EMPTY_WORKSPACE,
  ProjectId,
  ProjectNotFoundError
} from '@shared/domain/project'
import { AgentItem, ProjectRemoved, Removed } from '@shared/domain/project-removal'
import type { TranscriptWidth } from '@shared/domain/transcript-width'
import {
  CreateTab,
  EditQueuedMessage,
  type IpcEvent,
  MoveProject,
  type PaneCreateFailed,
  RemoveQueuedMessage,
  RenameTab,
  ResolvePermission,
  ResolvePlanReview,
  ResolveQuestion,
  RewindToCheckpoint,
  SelectTab,
  SendMessage,
  SetTranscriptWidth
} from '@shared/ipc/contract'
import { Effect, FileSystem, Layer, Option, Stream } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { InvalidOverrideError, PluginSources } from '../plugins/plugin-sources'
import { AdapterStatusFeed } from '../services/adapter-status-feed'
import { AgentSummaries } from '../services/agent-summaries'
import { BackgroundActivities } from '../services/background-activities'
import { type CommandDeduper, makeCommandDeduperLive } from '../services/command-deduper'
import { EventHub } from '../services/event-hub'
import { ModelCatalogFeed } from '../services/model-catalog-feed'
import { ModelPreferences } from '../services/model-preferences'
import { type PaneHandle, PaneSupervisor } from '../services/pane-supervisor'
import { PaneWorkspace } from '../services/pane-workspace'
import { SettingsStore } from '../services/settings-store'
import { makeDiaRpcHandlers } from './rpc-handlers'

const PANE_ID = '00000000-0000-4000-8000-00000000000a'
const OTHER_PANE_ID = '00000000-0000-4000-8000-00000000000b'
const PROJECT_ID = ProjectId.make('00000000-0000-4000-8000-0000000000aa')

interface Harness {
  readonly calls: Array<string>
  readonly published: Array<IpcEvent>
  readonly layer: Layer.Layer<
    | PaneWorkspace
    | AgentSummaries
    | PaneSupervisor
    | SettingsStore
    | EventHub
    | FileSystem.FileSystem
    | CommandDeduper
    | HostPlugins
    | PluginSources
    | BackgroundActivities
    | ModelCatalogFeed
    | AdapterStatusFeed
    | ModelPreferences
  >
}

interface HarnessOptions {
  readonly livePanes?: ReadonlyArray<string>
  readonly knownPanes?: ReadonlyArray<string>
  readonly sendMessageFails?: boolean
  readonly createTabFails?: boolean
  readonly storedSendMode?: SendMode
  readonly storedTranscriptWidth?: TranscriptWidth
}

const sendMessage = (
  paneId: string,
  text: string,
  commandId: string,
  mode: SendMode = 'queue'
) => ({
  ...SendMessage.make({ paneId, text, mode }),
  commandId
})

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
  const live = new Set(options.livePanes ?? [])
  const known = new Set(options.knownPanes ?? [...live])

  const handle: PaneHandle = {
    sendMessage: (text, mode) =>
      options.sendMessageFails
        ? Effect.die(new Error('session is gone'))
        : Effect.sync(() => {
            calls.push(`sendMessage:${text}:${mode}`)
          }),
    editQueuedMessage: (messageId, text) =>
      Effect.sync(() => {
        calls.push(`editQueuedMessage:${messageId}:${text}`)
      }),
    removeQueuedMessage: (messageId) =>
      Effect.sync(() => {
        calls.push(`removeQueuedMessage:${messageId}`)
      }),
    messageQueue: Effect.succeed({ queued: [{ id: 'm-1', text: 'later' }], held: true }),
    setThinkingLevel: () => Effect.void,
    setPermissionMode: () => Effect.void,
    setModel: () => Effect.void,
    resolvePermission: (requestId) =>
      Effect.sync(() => {
        calls.push(`resolvePermission:${requestId}`)
      }),
    resolveQuestion: (requestId) =>
      Effect.sync(() => {
        calls.push(`resolveQuestion:${requestId}`)
      }),
    resolvePlanReview: (requestId) =>
      Effect.sync(() => {
        calls.push(`resolvePlanReview:${requestId}`)
      }),
    rewindToCheckpoint: (messageUuid, resumeAnchorUuid) =>
      Effect.sync(() => {
        calls.push(`rewindToCheckpoint:${messageUuid}:${resumeAnchorUuid}`)
      }),
    interrupt: () => Effect.void,
    markCrashed: () => Effect.void
  }

  const supervisor = Layer.succeed(PaneSupervisor, {
    openPane: () => Effect.die(new Error('openPane is not used by the handlers')),
    closePane: () => Effect.void,
    getHandle: (paneId) =>
      Effect.sync(() => (live.has(paneId) ? Option.some(handle) : Option.none())),
    closeAll: () => Effect.void
  })

  const workspace = Layer.succeed(PaneWorkspace, {
    getWorkspace: Effect.succeed(EMPTY_WORKSPACE),
    registerProject: (projectId, directory) =>
      directory === '/missing'
        ? Effect.fail(new DirectoryNotFoundError({ directory }))
        : Effect.sync(() => void calls.push(`registerProject:${projectId}:${directory}`)),
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
    selectTab: (paneId) => Effect.sync(() => void calls.push(`selectTab:${paneId ?? 'none'}`)),
    setThinkingLevel: () => Effect.void,
    setPermissionMode: () => Effect.void,
    setModel: (paneId, model) => Effect.sync(() => void calls.push(`setModel:${paneId}:${model}`)),
    getPaneHistory: () => Effect.succeed([]),
    resumePane: () => Effect.void,
    ensureLive: (paneId) =>
      Effect.sync(() => {
        calls.push(`ensureLive:${paneId}`)
        if (known.has(paneId)) live.add(paneId)
      })
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

  const models = Layer.succeed(ModelCatalogFeed, {
    start: Effect.void,
    current: Effect.die(new Error('current not used by these tests')),
    refresh: Effect.sync(() => {
      calls.push('refreshModels')
    })
  })

  const adapterStatus = Layer.succeed(AdapterStatusFeed, {
    start: Effect.void,
    current: Effect.die(new Error('current not used by these tests')),
    check: Effect.sync(() => {
      calls.push('checkHealth')
    }),
    setInstallPath: (path) =>
      Effect.sync(() => {
        calls.push(`setInstallPath:${path}`)
      })
  })

  const modelPreferences = Layer.succeed(ModelPreferences, {
    current: Effect.die(new Error('current not used by these tests')),
    set: (model, preference) =>
      model === 'last-visible'
        ? Effect.fail(new LastVisibleModel({ message: 'At least one model must stay visible' }))
        : Effect.sync(() => {
            calls.push(`setModelPreference:${model}:${Option.getOrElse(preference, () => 'none')}`)
          }),
    setDefaults: (defaults) =>
      Effect.sync(() => {
        calls.push(`setAgentDefaults:${JSON.stringify(defaults)}`)
      })
  })

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
      supervisor,
      workspace,
      summaries,
      settings,
      hub,
      FileSystem.layerNoop({}),
      makeCommandDeduperLive(),
      plugins,
      pluginSources,
      activities,
      models,
      adapterStatus,
      modelPreferences
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
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, NodePath.layer)))

describe('Dia RPC handlers', () => {
  it.effect('delivers the pane id and model of a SetModel unchanged, once per commandId', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ livePanes: [PANE_ID] })

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

  it.effect('delivers the model and preference of a SetModelPreference unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) =>
        Effect.gen(function* () {
          yield* handlers.SetModelPreference({ model: 'claude-opus-5', preference: 'favourite' })
          yield* handlers.SetModelPreference({ model: 'claude-haiku-5', preference: null })
        })
      )

      assert.deepStrictEqual(harness.calls, [
        'setModelPreference:claude-opus-5:favourite',
        'setModelPreference:claude-haiku-5:none'
      ])
    })
  )

  it.effect('returns the refusal to hide the last visible model as a typed error', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      const error = yield* withHandlers(harness, (handlers) =>
        Effect.flip(handlers.SetModelPreference({ model: 'last-visible', preference: 'hidden' }))
      )

      assert.strictEqual(error._tag, 'LastVisibleModel')
    })
  )

  it.effect('passes the SetInstallPath path, and null to clear it, to the adapter unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) =>
        Effect.gen(function* () {
          yield* handlers.SetInstallPath({ path: 'D:\\tools\\claude.exe' })
          yield* handlers.SetInstallPath({ path: null })
        })
      )

      assert.deepStrictEqual(harness.calls, [
        'setInstallPath:D:\\tools\\claude.exe',
        'setInstallPath:null'
      ])
    })
  )

  it.effect('applies a SendMessage once when the client resends it with the same commandId', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ livePanes: [PANE_ID] })

      yield* withHandlers(harness, (handlers) =>
        Effect.gen(function* () {
          const command = sendMessage(PANE_ID, 'hello', 'req-1')
          yield* handlers.SendMessage(command)
          yield* handlers.SendMessage(command)
        })
      )

      assert.deepStrictEqual(
        harness.calls.filter((call) => call.startsWith('sendMessage')),
        ['sendMessage:hello:queue']
      )
    })
  )

  it.effect('applies a SendMessage with a new commandId even when the text repeats', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ livePanes: [PANE_ID] })

      yield* withHandlers(harness, (handlers) =>
        Effect.gen(function* () {
          yield* handlers.SendMessage(sendMessage(PANE_ID, 'again', 'req-1'))
          yield* handlers.SendMessage(sendMessage(PANE_ID, 'again', 'req-2'))
        })
      )

      assert.deepStrictEqual(
        harness.calls.filter((call) => call.startsWith('sendMessage')),
        ['sendMessage:again:queue', 'sendMessage:again:queue']
      )
    })
  )

  it.effect(
    'starts the pane session before delivering a SendMessage to a pane with no live session',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ knownPanes: [PANE_ID] })

        yield* withHandlers(harness, (handlers) =>
          handlers.SendMessage(sendMessage(PANE_ID, 'wake up', 'req-1'))
        )

        assert.deepStrictEqual(harness.calls, [
          `ensureLive:${PANE_ID}`,
          'sendMessage:wake up:queue'
        ])
      })
  )

  it.effect(
    'starts the pane session before delivering a RewindToCheckpoint to a pane with no live session',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ knownPanes: [PANE_ID] })

        yield* withHandlers(harness, (handlers) =>
          handlers.RewindToCheckpoint({
            ...RewindToCheckpoint.make({
              paneId: PANE_ID,
              messageUuid: 'turn-2',
              resumeAnchorUuid: 'reply-1'
            }),
            commandId: 'req-1'
          })
        )

        assert.deepStrictEqual(harness.calls, [
          `ensureLive:${PANE_ID}`,
          'rewindToCheckpoint:turn-2:reply-1'
        ])
      })
  )

  it.effect('drops a SendMessage for a pane that does not exist without failing the RPC', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ knownPanes: [PANE_ID] })

      yield* withHandlers(harness, (handlers) =>
        handlers.SendMessage(sendMessage(OTHER_PANE_ID, 'lost', 'req-1'))
      )

      assert.deepStrictEqual(harness.calls, [`ensureLive:${OTHER_PANE_ID}`])
    })
  )

  it.effect('does not fail the RPC when the session rejects the message', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ livePanes: [PANE_ID], sendMessageFails: true })

      const exit = yield* withHandlers(harness, (handlers) =>
        handlers.SendMessage(sendMessage(PANE_ID, 'boom', 'req-1')).pipe(Effect.exit)
      )

      assert.isTrue(exit._tag === 'Success')
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
    'resolves permission, question and plan review prompts by the prompt requestId, not the commandId',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ livePanes: [PANE_ID] })

        yield* withHandlers(harness, (handlers) =>
          Effect.gen(function* () {
            yield* handlers.ResolvePermission({
              ...ResolvePermission.make({
                paneId: PANE_ID,
                requestId: 'prompt-permission',
                response: Deny.make({ message: 'no' })
              }),
              commandId: 'cmd-1'
            })
            yield* handlers.ResolveQuestion({
              ...ResolveQuestion.make({
                paneId: PANE_ID,
                requestId: 'prompt-question',
                response: FreeformResponse.make({ questions: [], response: 'skip' })
              }),
              commandId: 'cmd-2'
            })
            yield* handlers.ResolvePlanReview({
              ...ResolvePlanReview.make({
                paneId: PANE_ID,
                requestId: 'prompt-plan',
                approved: true
              }),
              commandId: 'cmd-3'
            })
          })
        )

        assert.deepStrictEqual(harness.calls, [
          'resolvePermission:prompt-permission',
          'resolveQuestion:prompt-question',
          'resolvePlanReview:prompt-plan'
        ])
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

  it.effect('delivers the send mode a SendMessage names to the pane unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ livePanes: [PANE_ID] })

      yield* withHandlers(harness, (handlers) =>
        handlers.SendMessage(sendMessage(PANE_ID, 'change course', 'req-1', 'steer'))
      )

      assert.deepStrictEqual(
        harness.calls.filter((call) => call.startsWith('sendMessage')),
        ['sendMessage:change course:steer']
      )
    })
  )

  it.effect('delivers the message id and text of an EditQueuedMessage to the pane unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ livePanes: [PANE_ID] })

      yield* withHandlers(harness, (handlers) =>
        handlers.EditQueuedMessage({
          ...EditQueuedMessage.make({ paneId: PANE_ID, messageId: 'm-7', text: 'edited text' }),
          commandId: 'req-1'
        })
      )

      assert.deepStrictEqual(harness.calls, ['editQueuedMessage:m-7:edited text'])
    })
  )

  it.effect('delivers the message id of a RemoveQueuedMessage to the pane unchanged', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ livePanes: [PANE_ID] })

      yield* withHandlers(harness, (handlers) =>
        handlers.RemoveQueuedMessage({
          ...RemoveQueuedMessage.make({ paneId: PANE_ID, messageId: 'm-7' }),
          commandId: 'req-1'
        })
      )

      assert.deepStrictEqual(harness.calls, ['removeQueuedMessage:m-7'])
    })
  )

  it.effect('returns the live pane queue, and an empty queue for a pane with no session', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ livePanes: [PANE_ID] })

      const [live, absent] = yield* withHandlers(harness, (handlers) =>
        Effect.all([
          handlers.GetMessageQueue({ paneId: PANE_ID }),
          handlers.GetMessageQueue({ paneId: OTHER_PANE_ID })
        ])
      )

      assert.deepStrictEqual(live, { queued: [{ id: 'm-1', text: 'later' }], held: true })
      assert.deepStrictEqual(absent, { queued: [], held: false })
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
})

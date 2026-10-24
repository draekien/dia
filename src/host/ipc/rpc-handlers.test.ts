import { NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Deny, FreeformResponse } from '@shared/domain/attention'
import { type PaneNode, PaneNotFoundError } from '@shared/domain/pane-tree'
import {
  CreatePane,
  type IpcEvent,
  LayoutChanged,
  type PaneCreateFailed,
  ResolvePermission,
  ResolvePlanReview,
  ResolveQuestion,
  SendMessage,
  SplitPane
} from '@shared/ipc/contract'
import { Effect, FileSystem, Layer, Option, Stream } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { InvalidOverrideError, PluginSources } from '../plugins/plugin-sources'
import { type CommandDeduper, makeCommandDeduperLive } from '../services/command-deduper'
import { EventHub } from '../services/event-hub'
import { type PaneHandle, PaneSupervisor } from '../services/pane-supervisor'
import { PaneWorkspace } from '../services/pane-workspace'
import { SettingsStore } from '../services/settings-store'
import { makeDiaRpcHandlers } from './rpc-handlers'

const PANE_ID = '00000000-0000-4000-8000-00000000000a'
const OTHER_PANE_ID = '00000000-0000-4000-8000-00000000000b'
const LAYOUT: PaneNode = { _tag: 'Leaf', paneId: PANE_ID, status: 'ready', cwd: '/repo' }

interface Harness {
  readonly calls: Array<string>
  readonly published: Array<IpcEvent>
  readonly layer: Layer.Layer<
    | PaneWorkspace
    | PaneSupervisor
    | SettingsStore
    | EventHub
    | FileSystem.FileSystem
    | CommandDeduper
    | HostPlugins
    | PluginSources
  >
}

interface HarnessOptions {
  readonly livePanes?: ReadonlyArray<string>
  readonly knownPanes?: ReadonlyArray<string>
  readonly sendMessageFails?: boolean
  readonly createPaneFails?: boolean
}

const sendMessage = (paneId: string, text: string, commandId: string) => ({
  ...SendMessage.make({ paneId, text }),
  commandId
})

const createPane = () => ({
  ...CreatePane.make({
    paneId: PANE_ID,
    cwd: '/repo',
    model: 'sonnet',
    thinkingLevel: 'adaptive',
    permissionMode: 'default',
    useWorktree: false
  }),
  commandId: 'req-1'
})

const makeHarness = (options: HarnessOptions = {}): Harness => {
  const calls: Array<string> = []
  const published: Array<IpcEvent> = []
  const live = new Set(options.livePanes ?? [])
  const known = new Set(options.knownPanes ?? [...live])

  const handle: PaneHandle = {
    sendMessage: (text) =>
      options.sendMessageFails
        ? Effect.die(new Error('session is gone'))
        : Effect.sync(() => {
            calls.push(`sendMessage:${text}`)
          }),
    setThinkingLevel: () => Effect.void,
    setPermissionMode: () => Effect.void,
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
    rewindToCheckpoint: () => Effect.void,
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
    getTree: () => Effect.succeed(LAYOUT),
    split: (paneId) =>
      known.has(paneId) ? Effect.succeed(LAYOUT) : Effect.fail(new PaneNotFoundError({ paneId })),
    createPane: (paneId) =>
      options.createPaneFails
        ? Effect.fail(new PaneNotFoundError({ paneId }))
        : Effect.sync(() => {
            calls.push(`createPane:${paneId}`)
            return LAYOUT
          }),
    setThinkingLevel: () => Effect.succeed(LAYOUT),
    setPermissionMode: () => Effect.succeed(LAYOUT),
    close: () => Effect.succeed(LAYOUT),
    getPaneHistory: () => Effect.succeed([]),
    resumePane: () => Effect.void,
    ensureLive: (paneId) =>
      Effect.sync(() => {
        calls.push(`ensureLive:${paneId}`)
        if (known.has(paneId)) live.add(paneId)
      })
  })

  const settings = Layer.succeed(SettingsStore, {
    getLastDirectory: () => Effect.succeed(Option.none()),
    setLastDirectory: () => Effect.void,
    getTheme: () => Effect.succeed(Option.none()),
    setTheme: () => Effect.void,
    getPluginOverrides: () => Effect.succeed({}),
    setPluginOverride: () => Effect.void,
    clearPluginOverride: () => Effect.void
  })

  const pluginInfo = (name: string) => ({
    name,
    origin: 'default' as const,
    root: `plugins/${name}`,
    status: { _tag: 'Loaded' as const },
    memoryBytes: 0
  })

  const plugins = Layer.succeed(HostPlugins, {
    list: () => Effect.succeed([pluginInfo('chat')]),
    start: () => Effect.void,
    inject: () => Effect.succeed(Option.none()),
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
      settings,
      hub,
      FileSystem.layerNoop({}),
      makeCommandDeduperLive(),
      plugins,
      pluginSources
    )
  }
}

const withHandlers = <A>(
  harness: Harness,
  use: (handlers: Effect.Success<typeof makeDiaRpcHandlers>) => Effect.Effect<A>
) =>
  Effect.gen(function* () {
    const handlers = yield* makeDiaRpcHandlers
    return yield* use(handlers)
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, NodePath.layer)))

describe('Dia RPC handlers', () => {
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
        ['sendMessage:hello']
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
        ['sendMessage:again', 'sendMessage:again']
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

        assert.deepStrictEqual(harness.calls, [`ensureLive:${PANE_ID}`, 'sendMessage:wake up'])
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

  it.effect('publishes the new layout after CreatePane succeeds', () =>
    Effect.gen(function* () {
      const harness = makeHarness()

      yield* withHandlers(harness, (handlers) => handlers.CreatePane(createPane()))

      assert.deepStrictEqual(harness.published, [LayoutChanged.make({ tree: LAYOUT })])
    })
  )

  it.effect('publishes PaneCreateFailed when CreatePane fails', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ createPaneFails: true })

      yield* withHandlers(harness, (handlers) => handlers.CreatePane(createPane()))

      assert.strictEqual(harness.published.length, 1)
      const event = harness.published[0]
      assert.isTrue(event._tag === 'PaneCreateFailed')
      assert.strictEqual((event as PaneCreateFailed).paneId, PANE_ID)
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

  it.effect('does not publish a layout when SplitPane targets an unknown pane', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ knownPanes: [PANE_ID] })

      yield* withHandlers(harness, (handlers) =>
        handlers.SplitPane({
          ...SplitPane.make({ paneId: OTHER_PANE_ID, direction: 'row' }),
          commandId: 'req-1'
        })
      )

      assert.deepStrictEqual(harness.published, [])
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
})

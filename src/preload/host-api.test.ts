import { type AdapterStatusSnapshot, HealthNotChecked } from '@shared/domain/adapter-status'
import { type AgentSummary, NoActivity, StatusIdle } from '@shared/domain/agent-summary'
import { Deny, FreeformResponse } from '@shared/domain/attention'
import { ActivityNotFound } from '@shared/domain/background-activity'
import { type ModelCatalogSnapshot, ModelsReady } from '@shared/domain/model'
import {
  EMPTY_ADAPTER_PREFERENCES,
  type ModelPreferencesSnapshot
} from '@shared/domain/model-preferences'
import {
  AgentName,
  DirectoryNotFoundError,
  EMPTY_WORKSPACE,
  ProjectId,
  ProjectNotFoundError
} from '@shared/domain/project'
import {
  AgentItem,
  ProjectRemoved,
  type RemovalProgress,
  Removed,
  Removing
} from '@shared/domain/project-removal'
import {
  type AdapterStatusSnapshotJson,
  type AgentSummariesReplaced,
  type IpcEvent,
  type ModelCatalogSnapshotJson,
  ModelsChanged,
  PaneAssistantTextDelta,
  type WorkspaceChanged
} from '@shared/ipc/contract'
import type { EventFrame } from '@shared/ipc/rpc'
import { Data, DateTime, Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DiaRpcClient, makeHostApi } from './host-api'

const PANE = '00000000-0000-4000-8000-00000000000a'
const PROJECT = ProjectId.make('00000000-0000-4000-8000-000000000001')
const SUMMARY: AgentSummary = {
  paneId: PANE,
  status: StatusIdle.make({}),
  activity: NoActivity.make({})
}

const textDelta = (text: string): IpcEvent => PaneAssistantTextDelta.make({ paneId: PANE, text })
const paneFrame = (seq: number, text: string): EventFrame => ({
  _tag: 'PaneEvent',
  paneId: PANE,
  seq,
  event: textDelta(text)
})
const reloadFrame: EventFrame = { _tag: 'ReloadHistory', paneId: PANE }

const SNAPSHOT: ModelCatalogSnapshot = {
  revision: 7,
  state: ModelsReady.make({
    models: [
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'Everyday tasks',
        adaptiveThinking: true,
        effortLevels: ['low', 'medium', 'high'],
        autoMode: true,
        fastMode: false
      }
    ],
    fetchedAt: DateTime.makeUnsafe('2026-10-25T15:00:00Z'),
    refreshing: false
  })
}
const SNAPSHOT_JSON: ModelCatalogSnapshotJson = {
  revision: 7,
  state: {
    _tag: 'Ready',
    models: [
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'Everyday tasks',
        adaptiveThinking: true,
        effortLevels: ['low', 'medium', 'high'],
        autoMode: true,
        fastMode: false
      }
    ],
    fetchedAt: '2026-10-25T15:00:00.000Z',
    refreshing: false
  }
}

const ADAPTER_STATUS: AdapterStatusSnapshot = {
  revision: 3,
  status: { health: HealthNotChecked.make({}), checking: false, installPathOverride: null }
}
const PREFERENCES: ModelPreferencesSnapshot = {
  revision: 5,
  preferences: EMPTY_ADAPTER_PREFERENCES
}

class ConnectionError extends Data.TaggedError('ConnectionError')<{ readonly reason: string }> {}

const dropped = Stream.fail(new ConnectionError({ reason: 'connection dropped' }))

const afterListenersAttach = (stream: Stream.Stream<EventFrame, ConnectionError>) =>
  Stream.fromEffect(Effect.promise(() => Promise.resolve())).pipe(
    Stream.drain,
    Stream.concat(stream)
  )

interface ClientScript {
  readonly sendMessageFailures?: number
  readonly subscriptions?: ReadonlyArray<Stream.Stream<EventFrame, ConnectionError>>
  readonly registerProject?: Effect.Effect<void, DirectoryNotFoundError>
  readonly removeProject?: Stream.Stream<RemovalProgress, ProjectNotFoundError>
  readonly getModels?: Effect.Effect<ModelCatalogSnapshot, ConnectionError>
  readonly runActivity?: Effect.Effect<void, ActivityNotFound>
}

const makeClient = (script: ClientScript = {}) => {
  let sendAttempts = 0
  let subscribeAttempts = 0
  const sendMessage = vi.fn((_payload: { commandId: string; text: string; mode: string }) =>
    ++sendAttempts <= (script.sendMessageFailures ?? 0)
      ? Effect.fail(new ConnectionError({ reason: 'connection down' }))
      : Effect.void
  )
  const resolvePrompt = vi.fn((_payload: { requestId: string; commandId: string }) => Effect.void)
  const subscribeEvents = vi.fn((_payload: { cursors: Record<string, number> }) => {
    const next = script.subscriptions?.[subscribeAttempts++]
    return next ?? Stream.never
  })
  const getWorkspace = vi.fn(() => Effect.succeed(EMPTY_WORKSPACE))
  const getAgentSummaries = vi.fn(() => Effect.succeed([SUMMARY]))
  const registerProject = vi.fn(
    (_payload: { projectId: string; directory: string }) => script.registerProject ?? Effect.void
  )
  const removeProject = vi.fn(
    (_payload: { projectId: string; force: boolean }) => script.removeProject ?? Stream.empty
  )
  const loadPlugin = vi.fn((payload: { name: string }) =>
    Effect.succeed({
      name: payload.name,
      origin: 'default' as const,
      root: `plugins/${payload.name}`,
      status: { _tag: 'Loaded' as const },
      memoryBytes: 0,
      provides: []
    })
  )
  const getModels = vi.fn(() => script.getModels ?? Effect.succeed(SNAPSHOT))
  const getAdapterStatus = vi.fn(() => Effect.succeed(ADAPTER_STATUS))
  const getModelPreferences = vi.fn(() => Effect.succeed(PREFERENCES))
  const runActivity = vi.fn(
    (_payload: { plugin: string; id: string }) => script.runActivity ?? Effect.void
  )
  const setPluginOverride = vi.fn((_payload: { name: string; directory: string }) =>
    Effect.succeed({ _tag: 'Rejected' as const, message: 'no plugin.json' })
  )
  const client = {
    LoadPlugin: loadPlugin,
    SetPluginOverride: setPluginOverride,
    SendMessage: sendMessage,
    ResolvePermission: resolvePrompt,
    ResolveQuestion: resolvePrompt,
    ResolvePlanReview: resolvePrompt,
    SubscribeEvents: subscribeEvents,
    GetWorkspace: getWorkspace,
    GetAgentSummaries: getAgentSummaries,
    RegisterProject: registerProject,
    RemoveProject: removeProject,
    GetModels: getModels,
    GetAdapterStatus: getAdapterStatus,
    GetModelPreferences: getModelPreferences,
    RunActivity: runActivity
  } as unknown as DiaRpcClient
  return {
    client,
    sendMessage,
    resolvePrompt,
    subscribeEvents,
    getWorkspace,
    getAgentSummaries,
    registerProject,
    removeProject,
    loadPlugin,
    setPluginOverride,
    getModels,
    runActivity
  }
}

const makeApi = (client: DiaRpcClient) => {
  let issuedRequestIds = 0
  const warn = vi.fn()
  const api = makeHostApi({
    client: Effect.succeed(client),
    pickDirectory: async () => null,
    newRequestId: () => `request-${issuedRequestIds++}`,
    warn
  })
  return { api, warn, issuedRequestIds: () => issuedRequestIds }
}

const advance = (milliseconds: number) => vi.advanceTimersByTimeAsync(milliseconds)

describe('makeHostApi', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resends a command that failed while the connection was down under the one commandId it was issued', async () => {
    const { client, sendMessage } = makeClient({ sendMessageFailures: 2 })
    const { api, issuedRequestIds } = makeApi(client)

    api.sendMessage(PANE, 'hello', 'queue')
    await advance(1200)

    expect(sendMessage.mock.calls.map(([payload]) => payload.commandId)).toEqual([
      'request-0',
      'request-0',
      'request-0'
    ])
    expect(issuedRequestIds()).toBe(1)
  })

  it('sends the prompt text and send mode in the SendMessage payload unchanged', async () => {
    const { client, sendMessage } = makeClient()
    const { api } = makeApi(client)

    api.sendMessage(PANE, 'change course', 'steer')
    await advance(0)

    expect(sendMessage.mock.calls.map(([payload]) => [payload.text, payload.mode])).toEqual([
      ['change course', 'steer']
    ])
  })

  it('sends the pending prompt requestId separately from the commandId when resolving a prompt', async () => {
    const { client, resolvePrompt } = makeClient()
    const { api } = makeApi(client)

    api.resolvePermission(PANE, 'prompt-permission', Deny.make({ message: 'no' }))
    api.resolveQuestion(
      PANE,
      'prompt-question',
      FreeformResponse.make({ questions: [], response: 'skip' })
    )
    api.resolvePlanReview(PANE, 'prompt-plan', true)
    await advance(0)

    expect(
      resolvePrompt.mock.calls.map(([payload]) => [payload.requestId, payload.commandId])
    ).toEqual([
      ['prompt-permission', 'request-0'],
      ['prompt-question', 'request-1'],
      ['prompt-plan', 'request-2']
    ])
  })

  it('stops resending a command once the resend window has passed and reports the failure', async () => {
    const { client, sendMessage } = makeClient({ sendMessageFailures: Number.MAX_SAFE_INTEGER })
    const { api, warn } = makeApi(client)

    api.sendMessage(PANE, 'hello', 'queue')
    await advance(31_000)
    const attemptsAtWindowEnd = sendMessage.mock.calls.length
    await advance(5_000)

    expect(sendMessage.mock.calls.length).toBe(attemptsAtWindowEnd)
    expect(warn).toHaveBeenCalledWith('Command SendMessage failed', expect.any(ConnectionError))
  })

  it('subscribes with no cursors at first and resumes from the last received sequence number after a drop', async () => {
    const { client, subscribeEvents } = makeClient({
      subscriptions: [
        afterListenersAttach(
          Stream.make(paneFrame(1, 'a'), paneFrame(2, 'b')).pipe(Stream.concat(dropped))
        )
      ]
    })
    const { api } = makeApi(client)
    const received: Array<string> = []
    api.onAssistantTextDelta((event) => {
      received.push(event.text)
    })

    await advance(1500)

    expect(subscribeEvents.mock.calls.map(([payload]) => payload.cursors)).toEqual([
      {},
      { [PANE]: 2 }
    ])
    expect(received).toEqual(['a', 'b'])
  })

  it('asks the renderer to reload a pane history on ReloadHistory and forgets that pane cursor', async () => {
    const { client, subscribeEvents } = makeClient({
      subscriptions: [
        afterListenersAttach(
          Stream.make(paneFrame(4, 'a'), reloadFrame).pipe(Stream.concat(dropped))
        )
      ]
    })
    const { api } = makeApi(client)
    const reloads: Array<string> = []
    api.onHistoryReloadRequested((paneId) => reloads.push(paneId))

    await advance(1500)

    expect(reloads).toEqual([PANE])
    expect(subscribeEvents.mock.calls[1][0].cursors).toEqual({})
  })

  it('re-reads the workspace and every agent summary after a reconnect but not on the first connection', async () => {
    const { client, getWorkspace } = makeClient({ subscriptions: [dropped] })
    const { api } = makeApi(client)
    const workspaces: Array<WorkspaceChanged> = []
    const replaced: Array<AgentSummariesReplaced> = []
    api.onWorkspaceChanged((event) => workspaces.push(event))
    api.onAgentSummariesReplaced((event) => replaced.push(event))

    await advance(10)
    expect(getWorkspace).not.toHaveBeenCalled()

    await advance(1500)

    expect(workspaces.map((event) => event.workspace)).toEqual([EMPTY_WORKSPACE])
    expect(replaced.map((event) => event.summaries)).toEqual([[SUMMARY]])
  })

  it('hands a ModelsChanged event to the renderer as plain JSON with an ISO fetchedAt', async () => {
    const frame: EventFrame = {
      _tag: 'GlobalEvent',
      event: ModelsChanged.make({ snapshot: SNAPSHOT })
    }
    const { client } = makeClient({ subscriptions: [afterListenersAttach(Stream.make(frame))] })
    const { api } = makeApi(client)
    const received: Array<ModelCatalogSnapshotJson> = []
    api.models.onChanged((snapshot) => received.push(structuredClone(snapshot)))

    await advance(10)

    expect(received).toEqual([SNAPSHOT_JSON])
  })

  it('re-reads the model list and the activities after a reconnect', async () => {
    const { client } = makeClient({ subscriptions: [dropped] })
    const { api } = makeApi(client)
    const models: Array<ModelCatalogSnapshotJson> = []
    let activityChanges = 0
    api.models.onChanged((snapshot) => models.push(snapshot))
    api.activities.onChanged(() => {
      activityChanges += 1
    })

    await advance(1500)

    expect(models).toEqual([SNAPSHOT_JSON])
    expect(activityChanges).toBe(1)
  })

  it('re-reads the adapter status and the model preferences after a reconnect', async () => {
    const { client } = makeClient({ subscriptions: [dropped] })
    const { api } = makeApi(client)
    const statuses: Array<AdapterStatusSnapshotJson> = []
    const preferences: Array<ModelPreferencesSnapshot> = []
    api.adapter.onStatusChanged((snapshot) => statuses.push(snapshot))
    api.adapter.onPreferencesChanged((snapshot) => preferences.push(snapshot))

    await advance(1500)

    expect(statuses).toEqual([
      {
        revision: 3,
        status: { health: { _tag: 'HealthNotChecked' }, checking: false, installPathOverride: null }
      }
    ])
    expect(preferences).toEqual([PREFERENCES])
  })

  it('still re-reads the workspace after a reconnect when the model list cannot be read', async () => {
    const { client } = makeClient({
      subscriptions: [dropped],
      getModels: Effect.fail(new ConnectionError({ reason: 'connection down' }))
    })
    const { api, warn } = makeApi(client)
    const workspaces: Array<WorkspaceChanged> = []
    api.onWorkspaceChanged((event) => workspaces.push(event))

    await advance(1500)

    expect(workspaces.map((event) => event.workspace)).toEqual([EMPTY_WORKSPACE])
    expect(warn.mock.calls.map(([message]) => message)).toContain('Model list refresh failed')
  })

  it('sends the plugin and activity id to RunActivity and resolves null once it ran', async () => {
    const { client, runActivity } = makeClient()
    const { api } = makeApi(client)

    const result = await api.activities.run('claude-code', 'models')

    expect(runActivity.mock.calls.map(([payload]) => payload)).toEqual([
      { plugin: 'claude-code', id: 'models' }
    ])
    expect(result).toBeNull()
  })

  it('resolves running an unknown activity as the plain refusal', async () => {
    const { client } = makeClient({
      runActivity: Effect.fail(new ActivityNotFound({ plugin: 'claude-code', id: 'gone' }))
    })
    const { api } = makeApi(client)

    const result = await api.activities.run('claude-code', 'gone')

    expect(result).toStrictEqual({ _tag: 'ActivityNotFound', plugin: 'claude-code', id: 'gone' })
  })

  it('sends the project id and directory to RegisterProject and resolves null once registered', async () => {
    const { client, registerProject } = makeClient()
    const { api } = makeApi(client)

    const result = await api.registerProject(PROJECT, '/repo')

    expect(registerProject.mock.calls.map(([payload]) => payload)).toEqual([
      { projectId: PROJECT, directory: '/repo' }
    ])
    expect(result).toBeNull()
  })

  it('resolves a refused registration as the plain refusal, so it survives contextBridge', async () => {
    const error = new DirectoryNotFoundError({ directory: '/missing' })
    const { client } = makeClient({ registerProject: Effect.fail(error) })
    const { api } = makeApi(client)

    const result = await api.registerProject(PROJECT, '/missing')

    expect(result).toStrictEqual({ _tag: 'DirectoryNotFoundError', directory: '/missing' })
  })

  it('forwards every removal progress step in order and sends the force flag unchanged', async () => {
    const item = AgentItem.make({ paneId: PANE, name: AgentName.make('heron') })
    const steps: Array<RemovalProgress> = [
      Removing.make({ item }),
      Removed.make({ item }),
      ProjectRemoved.make({})
    ]
    const { client, removeProject } = makeClient({ removeProject: Stream.fromIterable(steps) })
    const { api } = makeApi(client)
    const received: Array<RemovalProgress> = []

    await api.removeProject(PROJECT, true, (progress) => received.push(progress))

    expect(removeProject.mock.calls.map(([payload]) => payload)).toEqual([
      { projectId: PROJECT, force: true }
    ])
    expect(received).toEqual(steps)
  })

  it('resolves removing a project that is already gone instead of rejecting', async () => {
    const error = new ProjectNotFoundError({ projectId: PROJECT })
    const { client } = makeClient({ removeProject: Stream.fail(error) })
    const { api } = makeApi(client)

    await expect(api.removeProject(PROJECT, false, () => undefined)).resolves.toBeUndefined()
  })

  it('sends the plugin name to LoadPlugin and resolves with the plugin state the Host returned', async () => {
    const { client, loadPlugin } = makeClient()
    const { api } = makeApi(client)

    const info = await api.plugins.load('example')

    expect(loadPlugin.mock.calls.map(([payload]) => payload)).toEqual([{ name: 'example' }])
    expect(info).toEqual({
      name: 'example',
      origin: 'default',
      root: 'plugins/example',
      status: { _tag: 'Loaded' },
      memoryBytes: 0,
      provides: []
    })
  })

  it('resolves a refused override as Rejected with the reason instead of throwing', async () => {
    const { client, setPluginOverride } = makeClient()
    const { api } = makeApi(client)

    const result = await api.plugins.setOverride('example', '/tree/example')

    expect(setPluginOverride.mock.calls.map(([payload]) => payload)).toEqual([
      { name: 'example', directory: '/tree/example' }
    ])
    expect(result).toEqual({ _tag: 'Rejected', message: 'no plugin.json' })
  })
})

describe('pickDirectory', () => {
  const apiPicking = (chosen: string | null) => {
    const client = {} as unknown as DiaRpcClient
    const pickDirectory = vi.fn(async (_defaultPath: string | null) => chosen)
    const api = makeHostApi({
      client: Effect.succeed(client),
      pickDirectory,
      newRequestId: () => 'request-0',
      warn: vi.fn()
    })
    return { api, pickDirectory }
  }

  it('resolves the path the user chose', async () => {
    const { api } = apiPicking('/tree/example')

    expect(await api.pickDirectory()).toBe('/tree/example')
  })

  it('resolves null when the user cancels the picker', async () => {
    const { api } = apiPicking(null)

    expect(await api.pickDirectory()).toBeNull()
  })
})

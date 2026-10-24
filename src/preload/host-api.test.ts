import { Deny, FreeformResponse } from '@shared/domain/attention'
import type { PaneNode } from '@shared/domain/pane-tree'
import { type IpcEvent, PaneAssistantTextDelta } from '@shared/ipc/contract'
import type { EventFrame } from '@shared/ipc/rpc'
import { Data, Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DiaRpcClient, makeHostApi } from './host-api'

const PANE = '00000000-0000-4000-8000-00000000000a'
const LAYOUT: PaneNode = { _tag: 'Leaf', paneId: PANE, status: 'ready', cwd: '/repo' }

const textDelta = (text: string): IpcEvent => PaneAssistantTextDelta.make({ paneId: PANE, text })
const paneFrame = (seq: number, text: string): EventFrame => ({
  _tag: 'PaneEvent',
  paneId: PANE,
  seq,
  event: textDelta(text)
})
const reloadFrame: EventFrame = { _tag: 'ReloadHistory', paneId: PANE }

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
}

const makeClient = (script: ClientScript = {}) => {
  let sendAttempts = 0
  let subscribeAttempts = 0
  const sendMessage = vi.fn((_payload: { commandId: string }) =>
    ++sendAttempts <= (script.sendMessageFailures ?? 0)
      ? Effect.fail(new ConnectionError({ reason: 'connection down' }))
      : Effect.void
  )
  const resolvePrompt = vi.fn((_payload: { requestId: string; commandId: string }) => Effect.void)
  const subscribeEvents = vi.fn((_payload: { cursors: Record<string, number> }) => {
    const next = script.subscriptions?.[subscribeAttempts++]
    return next ?? Stream.never
  })
  const getInitialLayout = vi.fn(() => Effect.succeed(LAYOUT))
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
    GetInitialLayout: getInitialLayout
  } as unknown as DiaRpcClient
  return {
    client,
    sendMessage,
    resolvePrompt,
    subscribeEvents,
    getInitialLayout,
    loadPlugin,
    setPluginOverride
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

    api.sendMessage(PANE, 'hello')
    await advance(1200)

    expect(sendMessage.mock.calls.map(([payload]) => payload.commandId)).toEqual([
      'request-0',
      'request-0',
      'request-0'
    ])
    expect(issuedRequestIds()).toBe(1)
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

    api.sendMessage(PANE, 'hello')
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

  it('re-fetches the layout after a reconnect but not on the first connection', async () => {
    const { client, getInitialLayout } = makeClient({ subscriptions: [dropped] })
    const { api } = makeApi(client)
    const layouts: Array<PaneNode> = []
    api.onLayoutChanged((event) => layouts.push(event.tree))

    await advance(10)
    expect(getInitialLayout).not.toHaveBeenCalled()

    await advance(1500)

    expect(getInitialLayout).toHaveBeenCalledTimes(1)
    expect(layouts).toEqual([LAYOUT])
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
    const recordChosenDirectory = vi.fn(() => Effect.succeed(null))
    const client = {
      GetLastDirectory: () => Effect.succeed('/last'),
      RecordChosenDirectory: recordChosenDirectory
    } as unknown as DiaRpcClient
    const pickDirectory = vi.fn(async (_defaultPath: string | null) => chosen)
    const api = makeHostApi({
      client: Effect.succeed(client),
      pickDirectory,
      newRequestId: () => 'request-0',
      warn: vi.fn()
    })
    return { api, pickDirectory, recordChosenDirectory }
  }

  it('resolves the path the user chose without recording it as the last pane directory', async () => {
    const { api, recordChosenDirectory } = apiPicking('/tree/example')

    const chosen = await api.pickDirectory()

    expect(chosen).toBe('/tree/example')
    expect(recordChosenDirectory).not.toHaveBeenCalled()
  })

  it('resolves null when the user cancels the picker', async () => {
    const { api } = apiPicking(null)

    expect(await api.pickDirectory()).toBeNull()
  })
})

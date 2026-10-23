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
  const sendMessage = vi.fn((_payload: { requestId: string }) =>
    ++sendAttempts <= (script.sendMessageFailures ?? 0)
      ? Effect.fail(new ConnectionError({ reason: 'connection down' }))
      : Effect.void
  )
  const subscribeEvents = vi.fn((_payload: { cursors: Record<string, number> }) => {
    const next = script.subscriptions?.[subscribeAttempts++]
    return next ?? Stream.never
  })
  const getInitialLayout = vi.fn(() => Effect.succeed(LAYOUT))
  const client = {
    SendMessage: sendMessage,
    SubscribeEvents: subscribeEvents,
    GetInitialLayout: getInitialLayout
  } as unknown as DiaRpcClient
  return { client, sendMessage, subscribeEvents, getInitialLayout }
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

  it('resends a command that failed while the connection was down under the one requestId it was issued', async () => {
    const { client, sendMessage } = makeClient({ sendMessageFailures: 2 })
    const { api, issuedRequestIds } = makeApi(client)

    api.sendMessage(PANE, 'hello')
    await advance(1200)

    expect(sendMessage.mock.calls.map(([payload]) => payload.requestId)).toEqual([
      'request-0',
      'request-0',
      'request-0'
    ])
    expect(issuedRequestIds()).toBe(1)
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
})

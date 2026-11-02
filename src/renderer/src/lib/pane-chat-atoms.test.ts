// @effect-diagnostics newPromise:off -- the test holds each snapshot fetch open with a manually resolved Promise.
import { type PaneChatSnapshot, paneChatStateFromHistory } from '@shared/domain/pane-chat'
import { PaneAssistantTextDelta } from '@shared/ipc/contract'
import { PaneEventFrame } from '@shared/ipc/rpc'
import { AsyncResult, AtomRegistry } from 'effect/reactivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { paneChatAtom } from './pane-chat-atoms'

const PANE = '00000000-0000-4000-8000-00000000000a'
const OTHER_PANE = '00000000-0000-4000-8000-00000000000b'

const snapshotOf = (seq: number, ...userTexts: ReadonlyArray<string>): PaneChatSnapshot => ({
  state: paneChatStateFromHistory(
    PANE,
    userTexts.map((content) => ({ role: 'user', content }))
  ),
  seq
})

const delta = (seq: number, text: string, paneId = PANE) =>
  PaneEventFrame.make({ paneId, seq, event: PaneAssistantTextDelta.make({ paneId, text }) })

const installFakeDia = () => {
  const reloadListeners = new Set<(paneId: string) => void>()
  const frameListeners = new Set<(frame: PaneEventFrame) => void>()
  const pendingSnapshots: Array<(snapshot: PaneChatSnapshot) => void> = []
  const getPaneChat = vi.fn(
    (_paneId: string) =>
      new Promise<PaneChatSnapshot>((resolve) => void pendingSnapshots.push(resolve))
  )
  const noSubscription = () => () => undefined
  vi.stubGlobal('window', {
    dia: {
      getPaneChat,
      models: { onChanged: noSubscription, get: async () => undefined },
      onHistoryReloadRequested: (listener: (paneId: string) => void) => {
        reloadListeners.add(listener)
        return () => reloadListeners.delete(listener)
      },
      onPaneEvent: (listener: (frame: PaneEventFrame) => void) => {
        frameListeners.add(listener)
        return () => frameListeners.delete(listener)
      }
    }
  })
  return {
    getPaneChat,
    answerSnapshot: async (snapshot: PaneChatSnapshot) => {
      await vi.waitFor(() => expect(pendingSnapshots.length).toBeGreaterThan(0))
      pendingSnapshots.shift()?.(snapshot)
    },
    pushFrame: (frame: PaneEventFrame) => {
      for (const listener of frameListeners) listener(frame)
    },
    requestReload: (paneId: string) => {
      for (const listener of reloadListeners) listener(paneId)
    },
    listenerCount: () => reloadListeners.size + frameListeners.size
  }
}

const messageTexts = (
  registry: AtomRegistry.AtomRegistry,
  paneId: string
): ReadonlyArray<string> | undefined => {
  const result = registry.get(paneChatAtom(paneId))
  if (!AsyncResult.isSuccess(result)) return undefined
  return result.value.messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === 'text' ? [part.content] : []))
  )
}

describe('paneChatAtom', () => {
  let registry: AtomRegistry.AtomRegistry
  let unmount: () => void

  beforeEach(() => {
    registry = AtomRegistry.make()
  })

  afterEach(() => {
    unmount()
    vi.unstubAllGlobals()
  })

  it('stays pending until the Host snapshot arrives, then shows it', async () => {
    const dia = installFakeDia()
    unmount = registry.mount(paneChatAtom(PANE))
    expect(messageTexts(registry, PANE)).toBeUndefined()

    await dia.answerSnapshot(snapshotOf(4, 'hello'))

    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['hello']))
    expect(dia.getPaneChat).toHaveBeenCalledWith(PANE)
  })

  it('folds a frame numbered above the snapshot onto it', async () => {
    const dia = installFakeDia()
    unmount = registry.mount(paneChatAtom(PANE))
    await dia.answerSnapshot(snapshotOf(4, 'hello'))
    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['hello']))

    dia.pushFrame(delta(5, 'hi'))

    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['hello', 'hi']))
  })

  it('applies a frame that arrived during the fetch only when the snapshot does not cover it', async () => {
    const dia = installFakeDia()
    unmount = registry.mount(paneChatAtom(PANE))
    await vi.waitFor(() => expect(dia.getPaneChat).toHaveBeenCalledTimes(1))
    dia.pushFrame(delta(4, 'covered '))
    dia.pushFrame(delta(5, 'after'))

    await dia.answerSnapshot(snapshotOf(4, 'hello'))

    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['hello', 'after']))
  })

  it('drops a replayed frame it has already folded', async () => {
    const dia = installFakeDia()
    unmount = registry.mount(paneChatAtom(PANE))
    await dia.answerSnapshot(snapshotOf(0))
    dia.pushFrame(delta(1, 'once'))
    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['once']))

    dia.pushFrame(delta(1, 'once'))
    dia.pushFrame(delta(2, '!'))

    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['once!']))
  })

  it('ignores frames for another pane', async () => {
    const dia = installFakeDia()
    unmount = registry.mount(paneChatAtom(PANE))
    await dia.answerSnapshot(snapshotOf(0))

    dia.pushFrame(delta(1, 'elsewhere', OTHER_PANE))
    dia.pushFrame(delta(1, 'here'))

    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['here']))
  })

  it('replaces its state with a fresh snapshot when the Host requests a reload', async () => {
    const dia = installFakeDia()
    unmount = registry.mount(paneChatAtom(PANE))
    await dia.answerSnapshot(snapshotOf(3, 'before'))
    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['before']))

    dia.requestReload(PANE)
    await vi.waitFor(() => expect(dia.getPaneChat).toHaveBeenCalledTimes(2))
    dia.pushFrame(delta(9, 'covered '))
    dia.pushFrame(delta(10, 'live'))
    await dia.answerSnapshot(snapshotOf(9, 'before', 'missed while disconnected'))

    await vi.waitFor(() =>
      expect(messageTexts(registry, PANE)).toEqual(['before', 'missed while disconnected', 'live'])
    )
  })

  it('ignores a reload request for another pane', async () => {
    const dia = installFakeDia()
    unmount = registry.mount(paneChatAtom(PANE))
    await dia.answerSnapshot(snapshotOf(0, 'before'))
    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['before']))

    dia.requestReload(OTHER_PANE)
    dia.pushFrame(delta(1, 'live'))

    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['before', 'live']))
    expect(dia.getPaneChat).toHaveBeenCalledTimes(1)
  })

  it('stops listening once the atom is released', async () => {
    const dia = installFakeDia()
    unmount = registry.mount(paneChatAtom(PANE))
    await dia.answerSnapshot(snapshotOf(0))
    await vi.waitFor(() => expect(dia.listenerCount()).toBe(2))

    unmount()
    unmount = () => undefined
    registry.dispose()

    await vi.waitFor(() => expect(dia.listenerCount()).toBe(0))
  })
})

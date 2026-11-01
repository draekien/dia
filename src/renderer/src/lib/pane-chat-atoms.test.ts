import { EMPTY_MESSAGE_QUEUE } from '@shared/domain/message-queue'
import { CopySetupStep, SessionSetupStep, WorktreeSetupStep } from '@shared/domain/tab-setup'
import { PaneContextUsageChanged, PaneSetupProgress } from '@shared/ipc/contract'
import { AsyncResult, AtomRegistry } from 'effect/reactivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { paneChatAtom } from './pane-chat-atoms'

const PANE = '00000000-0000-4000-8000-00000000000a'
const OTHER_PANE = '00000000-0000-4000-8000-00000000000b'

interface FakeDia {
  readonly getPaneHistory: ReturnType<typeof vi.fn>
  readonly requestReload: (paneId: string) => void
  readonly pushContextUsage: (event: PaneContextUsageChanged) => void
  readonly pushSetup: (event: PaneSetupProgress) => void
  readonly reloadListenerCount: () => number
}

const installFakeDia = (
  histories: ReadonlyArray<ReadonlyArray<{ role: string; content: string }>>
) => {
  const reloadListeners = new Set<(paneId: string) => void>()
  const usageListeners = new Set<(event: PaneContextUsageChanged) => void>()
  const setupListeners = new Set<(event: PaneSetupProgress) => void>()
  let call = 0
  const getPaneHistory = vi.fn(async () => histories[Math.min(call++, histories.length - 1)])
  const noSubscription = () => () => undefined
  const dia = new Proxy(
    {
      getPaneHistory,
      getMessageQueue: async () => EMPTY_MESSAGE_QUEUE,
      models: { onChanged: noSubscription, get: async () => undefined },
      onHistoryReloadRequested: (listener: (paneId: string) => void) => {
        reloadListeners.add(listener)
        return () => reloadListeners.delete(listener)
      },
      onContextUsageChanged: (listener: (event: PaneContextUsageChanged) => void) => {
        usageListeners.add(listener)
        return () => usageListeners.delete(listener)
      },
      onSetupProgress: (listener: (event: PaneSetupProgress) => void) => {
        setupListeners.add(listener)
        return () => setupListeners.delete(listener)
      }
    } as Record<string, unknown>,
    { get: (target, key: string) => target[key] ?? noSubscription() }
  )
  vi.stubGlobal('window', { dia })
  const fake: FakeDia = {
    getPaneHistory,
    requestReload: (paneId) => {
      for (const listener of reloadListeners) listener(paneId)
    },
    pushContextUsage: (event) => {
      for (const listener of usageListeners) listener(event)
    },
    pushSetup: (event) => {
      for (const listener of setupListeners) listener(event)
    },
    reloadListenerCount: () => reloadListeners.size
  }
  return fake
}

const messageTexts = (
  registry: AtomRegistry.AtomRegistry,
  paneId: string
): ReadonlyArray<string> => {
  const result = registry.get(paneChatAtom(paneId))
  if (!AsyncResult.isSuccess(result)) return []
  return result.value.messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === 'text' ? [part.content] : []))
  )
}

const contextUsage = (registry: AtomRegistry.AtomRegistry, paneId: string) => {
  const result = registry.get(paneChatAtom(paneId))
  return AsyncResult.isSuccess(result) ? result.value.contextUsage : undefined
}

describe('paneChatAtom history reload', () => {
  let registry: AtomRegistry.AtomRegistry
  let unmount: () => void

  beforeEach(() => {
    registry = AtomRegistry.make()
  })

  afterEach(() => {
    unmount()
    vi.unstubAllGlobals()
  })

  it('replaces the pane messages with freshly fetched history when the Host requests a reload', async () => {
    const dia = installFakeDia([
      [{ role: 'user', content: 'before' }],
      [
        { role: 'user', content: 'before' },
        { role: 'assistant', content: 'missed while disconnected' }
      ]
    ])
    unmount = registry.mount(paneChatAtom(PANE))
    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['before']))

    dia.requestReload(PANE)

    await vi.waitFor(() =>
      expect(messageTexts(registry, PANE)).toEqual(['before', 'missed while disconnected'])
    )
    expect(dia.getPaneHistory).toHaveBeenCalledTimes(2)
  })

  it('ignores a reload request for another pane', async () => {
    const dia = installFakeDia([
      [{ role: 'user', content: 'before' }],
      [{ role: 'user', content: 'after' }]
    ])
    unmount = registry.mount(paneChatAtom(PANE))
    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['before']))

    dia.requestReload(OTHER_PANE)
    dia.requestReload(PANE)

    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['after']))
    expect(dia.getPaneHistory).toHaveBeenCalledTimes(2)
  })

  it('keeps the context usage reading across a history reload', async () => {
    const usage = { totalTokens: 41_000, maxTokens: 200_000 }
    const dia = installFakeDia([
      [{ role: 'user', content: 'before' }],
      [{ role: 'user', content: 'after' }]
    ])
    unmount = registry.mount(paneChatAtom(PANE))
    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['before']))
    dia.pushContextUsage(PaneContextUsageChanged.make({ paneId: PANE, usage }))
    await vi.waitFor(() => expect(contextUsage(registry, PANE)).toEqual(usage))

    dia.requestReload(PANE)

    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['after']))
    expect(contextUsage(registry, PANE)).toEqual(usage)
  })

  it('keeps the setup steps across a history reload', async () => {
    const steps = [
      WorktreeSetupStep.make({ reattach: true, state: 'done', branch: 'dia/quiet-otter' }),
      CopySetupStep.make({ state: 'running', files: [{ path: '.env' }] }),
      SessionSetupStep.make({ state: 'pending' })
    ]
    const dia = installFakeDia([
      [{ role: 'user', content: 'before' }],
      [{ role: 'user', content: 'after' }]
    ])
    unmount = registry.mount(paneChatAtom(PANE))
    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['before']))
    dia.pushSetup(PaneSetupProgress.make({ paneId: PANE, steps }))

    dia.requestReload(PANE)

    await vi.waitFor(() => expect(messageTexts(registry, PANE)).toEqual(['after']))
    const result = registry.get(paneChatAtom(PANE))
    expect(AsyncResult.isSuccess(result) ? result.value.setup : undefined).toEqual(steps)
  })

  it('stops listening for reload requests once the atom is released', async () => {
    const dia = installFakeDia([[{ role: 'user', content: 'before' }]])
    unmount = registry.mount(paneChatAtom(PANE))
    await vi.waitFor(() => expect(dia.reloadListenerCount()).toBe(1))

    unmount()
    registry.dispose()

    await vi.waitFor(() => expect(dia.reloadListenerCount()).toBe(0))
  })
})

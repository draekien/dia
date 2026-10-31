import { Crashed, Errored, Idle, PaneError } from '@shared/domain/attention'
import {
  PaneAttentionChanged,
  PaneRewindFailed,
  PaneRewoundToCheckpoint
} from '@shared/ipc/contract'
import { AtomRegistry } from 'effect/reactivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { paneRewindAtom } from './pane-chat-atoms'
import type { RewindProgress } from './pane-rewind'

const PANE = '00000000-0000-4000-8000-00000000000c'
const OTHER_PANE = '00000000-0000-4000-8000-00000000000d'
const TARGET = { checkpointUuid: 'cp-2', resumeAnchorUuid: 'anchor-a1' }
const REWIND_OUTCOME_TIMEOUT_MS = 45_000

const installFakeDia = () => {
  const listeners = new Map<string, Set<(event: never) => void>>()
  const subscribe = (name: string) => (listener: (event: never) => void) => {
    const set = listeners.get(name) ?? new Set()
    set.add(listener)
    listeners.set(name, set)
    return () => set.delete(listener)
  }
  const rewindToCheckpoint = vi.fn()
  vi.stubGlobal('window', {
    dia: {
      rewindToCheckpoint,
      onRewindFailed: subscribe('onRewindFailed'),
      onRewoundToCheckpoint: subscribe('onRewoundToCheckpoint'),
      onAttentionChanged: subscribe('onAttentionChanged'),
      onHistoryReloadRequested: subscribe('onHistoryReloadRequested')
    }
  })
  const push = (name: string, event: unknown): void => {
    for (const listener of listeners.get(name) ?? []) listener(event as never)
  }
  return { rewindToCheckpoint, push }
}

const crashed = (paneId: string) =>
  PaneAttentionChanged.make({
    paneId,
    attention: Crashed.make({ error: PaneError.make({ message: 'pane process exited' }) })
  })

describe('paneRewindAtom', () => {
  let registry: AtomRegistry.AtomRegistry
  let unmount: () => void
  let dia: ReturnType<typeof installFakeDia>
  const progress = (): RewindProgress => registry.get(paneRewindAtom(PANE))
  const start = (): void => registry.set(paneRewindAtom(PANE), { type: 'start', target: TARGET })

  beforeEach(() => {
    vi.useFakeTimers()
    dia = installFakeDia()
    registry = AtomRegistry.make()
    unmount = registry.mount(paneRewindAtom(PANE))
  })

  afterEach(() => {
    unmount()
    registry.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts idle', () => {
    expect(progress()).toEqual({ status: 'idle' })
  })

  it('sends the rewind and shows it running when started', () => {
    start()

    expect(dia.rewindToCheckpoint).toHaveBeenCalledWith(PANE, 'cp-2', 'anchor-a1')
    expect(progress()).toEqual({ status: 'rewinding', checkpointUuid: 'cp-2' })
  })

  it('sends no second rewind while one runs', () => {
    start()
    registry.set(paneRewindAtom(PANE), { type: 'start', target: { checkpointUuid: 'cp-3' } })

    expect(dia.rewindToCheckpoint).toHaveBeenCalledTimes(1)
    expect(progress()).toEqual({ status: 'rewinding', checkpointUuid: 'cp-2' })
  })

  it('shows the failure the pane reports for the running rewind', () => {
    start()

    dia.push(
      'onRewindFailed',
      PaneRewindFailed.make({
        paneId: PANE,
        messageUuid: 'cp-2',
        cause: 'FilesNotRewound',
        detail: 'No file checkpoint found for this message.'
      })
    )

    expect(progress()).toEqual({
      status: 'failed',
      checkpointUuid: 'cp-2',
      message: 'Rewind failed: No file checkpoint found for this message.'
    })
  })

  it('ignores a failure for another pane or another checkpoint', () => {
    start()

    dia.push(
      'onRewindFailed',
      PaneRewindFailed.make({ paneId: OTHER_PANE, messageUuid: 'cp-2', cause: 'Interrupted' })
    )
    dia.push(
      'onRewindFailed',
      PaneRewindFailed.make({ paneId: PANE, messageUuid: 'cp-9', cause: 'Interrupted' })
    )

    expect(progress()).toEqual({ status: 'rewinding', checkpointUuid: 'cp-2' })
  })

  it('returns to idle when the rewind completes', () => {
    start()

    dia.push(
      'onRewoundToCheckpoint',
      PaneRewoundToCheckpoint.make({ paneId: PANE, messageUuid: 'cp-2' })
    )

    expect(progress()).toEqual({ status: 'idle' })
  })

  it('dismisses a failure', () => {
    start()
    dia.push(
      'onRewindFailed',
      PaneRewindFailed.make({ paneId: PANE, messageUuid: 'cp-2', cause: 'Interrupted' })
    )

    registry.set(paneRewindAtom(PANE), { type: 'dismiss' })

    expect(progress()).toEqual({ status: 'idle' })
  })

  it('starts again from a failure', () => {
    start()
    dia.push(
      'onRewindFailed',
      PaneRewindFailed.make({ paneId: PANE, messageUuid: 'cp-2', cause: 'Interrupted' })
    )

    start()

    expect(dia.rewindToCheckpoint).toHaveBeenCalledTimes(2)
    expect(progress()).toEqual({ status: 'rewinding', checkpointUuid: 'cp-2' })
  })

  it('fails a rewind that gets no outcome within 45 seconds', () => {
    start()

    vi.advanceTimersByTime(REWIND_OUTCOME_TIMEOUT_MS - 1)
    expect(progress().status).toBe('rewinding')
    vi.advanceTimersByTime(1)

    expect(progress()).toEqual({
      status: 'failed',
      checkpointUuid: 'cp-2',
      message: 'Rewind failed: the agent did not respond.'
    })
  })

  it('does not time out a rewind that already completed', () => {
    start()
    dia.push(
      'onRewoundToCheckpoint',
      PaneRewoundToCheckpoint.make({ paneId: PANE, messageUuid: 'cp-2' })
    )

    vi.advanceTimersByTime(REWIND_OUTCOME_TIMEOUT_MS)

    expect(progress()).toEqual({ status: 'idle' })
  })

  it('clears a timed-out failure when the rewind completes late', () => {
    start()
    vi.advanceTimersByTime(REWIND_OUTCOME_TIMEOUT_MS)

    dia.push(
      'onRewoundToCheckpoint',
      PaneRewoundToCheckpoint.make({ paneId: PANE, messageUuid: 'cp-2' })
    )

    expect(progress()).toEqual({ status: 'idle' })
  })

  it.each([
    ['crashes', () => dia.push('onAttentionChanged', crashed(PANE))],
    [
      'errors',
      () =>
        dia.push(
          'onAttentionChanged',
          PaneAttentionChanged.make({
            paneId: PANE,
            attention: Errored.make({ error: PaneError.make({ message: 'turn failed' }) })
          })
        )
    ],
    ['reloads its history', () => dia.push('onHistoryReloadRequested', PANE)]
  ])('stops showing a running rewind when the pane %s', (_event, happen) => {
    start()

    happen()

    expect(progress()).toEqual({ status: 'idle' })
  })

  it('keeps a running rewind when another pane crashes or the pane goes idle', () => {
    start()

    dia.push('onAttentionChanged', crashed(OTHER_PANE))
    dia.push(
      'onAttentionChanged',
      PaneAttentionChanged.make({ paneId: PANE, attention: Idle.make({}) })
    )

    expect(progress()).toEqual({ status: 'rewinding', checkpointUuid: 'cp-2' })
  })
})

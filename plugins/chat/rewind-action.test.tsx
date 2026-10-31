// @vitest-environment jsdom

import type { RewindRowState } from '@dia/renderer-plugin'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RewindAction } from './rewind-action'

const HOLD_MS = 1000

const renderAction = (state: RewindRowState) => {
  const onStart = vi.fn()
  const onDismiss = vi.fn()
  const view = render(<RewindAction state={state} onStart={onStart} onDismiss={onDismiss} />)
  return { onStart, onDismiss, view }
}

const rewindButton = () => screen.getByRole('button', { name: /rewind to here/i })
const elapse = (ms: number) => act(() => vi.advanceTimersByTime(ms))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('RewindAction', () => {
  it('offers a press-and-hold rewind', () => {
    renderAction({ status: 'ready' })

    expect(rewindButton().textContent).toBe('Rewind')
    expect(rewindButton().getAttribute('aria-label')).toBe('Rewind to here, press and hold')
  })

  it('reads Hold while pressed', () => {
    renderAction({ status: 'ready' })

    fireEvent.pointerDown(rewindButton(), { button: 0 })

    expect(rewindButton().textContent).toBe('Hold')
  })

  it('starts the rewind after a one-second pointer hold', () => {
    const { onStart } = renderAction({ status: 'ready' })

    fireEvent.pointerDown(rewindButton(), { button: 0 })
    elapse(HOLD_MS - 1)
    expect(onStart).not.toHaveBeenCalled()
    elapse(1)

    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('cancels when the pointer is released early', () => {
    const { onStart } = renderAction({ status: 'ready' })

    fireEvent.pointerDown(rewindButton(), { button: 0 })
    elapse(HOLD_MS - 1)
    fireEvent.pointerUp(rewindButton())
    elapse(HOLD_MS)

    expect(onStart).not.toHaveBeenCalled()
    expect(rewindButton().textContent).toBe('Rewind')
  })

  it('cancels when the pointer leaves the button', () => {
    const { onStart } = renderAction({ status: 'ready' })

    fireEvent.pointerDown(rewindButton(), { button: 0 })
    fireEvent.pointerLeave(rewindButton())
    elapse(HOLD_MS)

    expect(onStart).not.toHaveBeenCalled()
  })

  it('ignores a secondary-button press', () => {
    const { onStart } = renderAction({ status: 'ready' })

    fireEvent.pointerDown(rewindButton(), { button: 2 })
    elapse(HOLD_MS)

    expect(onStart).not.toHaveBeenCalled()
  })

  it.each([' ', 'Enter'])('starts the rewind after holding %j for one second', (key) => {
    const { onStart } = renderAction({ status: 'ready' })

    fireEvent.keyDown(rewindButton(), { key })
    fireEvent.keyDown(rewindButton(), { key, repeat: true })
    elapse(HOLD_MS)

    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('cancels when the key is released early', () => {
    const { onStart } = renderAction({ status: 'ready' })

    fireEvent.keyDown(rewindButton(), { key: 'Enter' })
    fireEvent.keyUp(rewindButton(), { key: 'Enter' })
    elapse(HOLD_MS)

    expect(onStart).not.toHaveBeenCalled()
  })

  it('does not start from a click', () => {
    const { onStart } = renderAction({ status: 'ready' })

    fireEvent.click(rewindButton())
    elapse(HOLD_MS)

    expect(onStart).not.toHaveBeenCalled()
  })

  it('does not start once it unmounts mid-hold', () => {
    const { onStart, view } = renderAction({ status: 'ready' })

    fireEvent.pointerDown(rewindButton(), { button: 0 })
    view.unmount()
    elapse(HOLD_MS)

    expect(onStart).not.toHaveBeenCalled()
  })

  it('cannot start while another turn rewinds', () => {
    const { onStart } = renderAction({ status: 'blocked' })

    fireEvent.pointerDown(rewindButton(), { button: 0 })
    elapse(HOLD_MS)

    expect((rewindButton() as HTMLButtonElement).disabled).toBe(true)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('announces a running rewind in place of the control', () => {
    renderAction({ status: 'rewinding' })

    expect(screen.getByRole('status').textContent).toBe('Rewinding…')
    expect(screen.queryByRole('button', { name: /rewind to here/i })).toBeNull()
  })

  it('shows a failure as an alert, keeps the control to retry, and dismisses it', () => {
    const message = 'Rewind failed: No file checkpoint found for this message.'
    const { onDismiss } = renderAction({ status: 'failed', message })

    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(rewindButton()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

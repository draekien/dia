import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => [] as Array<FakeNotification>)

interface FakeNotification {
  readonly options: { readonly title: string; readonly body: string }
  readonly listeners: Map<string, () => void>
  shown: boolean
  closed: boolean
}

vi.mock('electron', () => ({
  Notification: class {
    readonly listeners = new Map<string, () => void>()
    shown = false
    closed = false
    constructor(readonly options: { readonly title: string; readonly body: string }) {
      toasts.push(this)
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener)
    }
    show() {
      this.shown = true
    }
    close() {
      this.closed = true
    }
  }
}))

const { isWindowAttended, makeAgentNotifier } = await import('./agent-notifications')

const fakeWindow = (state: { visible: boolean; minimized: boolean; focused: boolean }) => {
  const calls: Array<string> = []
  const window = {
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.focused,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  } as unknown as BrowserWindow
  return { window, calls }
}

const NOTIFICATION = { paneId: 'pane-1', title: 'brave-otter in dia', body: 'Failed: boom' }

beforeEach(() => {
  toasts.length = 0
})

describe('isWindowAttended', () => {
  it.each([
    [{ visible: true, minimized: false, focused: true }, true],
    [{ visible: false, minimized: false, focused: false }, false],
    [{ visible: true, minimized: true, focused: false }, false],
    [{ visible: true, minimized: false, focused: false }, false]
  ])('is %o -> %s', (state, expected) => {
    expect(isWindowAttended(fakeWindow(state).window)).toBe(expected)
  })
})

describe('makeAgentNotifier', () => {
  it('shows the notification with its title and body', () => {
    const notify = makeAgentNotifier(
      fakeWindow({ visible: true, minimized: false, focused: false }).window,
      () => {}
    )

    notify(NOTIFICATION)

    expect(toasts.map((toast) => [toast.options, toast.shown])).toEqual([
      [{ title: 'brave-otter in dia', body: 'Failed: boom' }, true]
    ])
  })

  it('restores, shows and focuses a minimised window on click, then reports the pane', () => {
    const { window, calls } = fakeWindow({ visible: true, minimized: true, focused: false })
    const clicked: Array<string> = []
    makeAgentNotifier(window, (paneId) => clicked.push(paneId))(NOTIFICATION)

    toasts[0]?.listeners.get('click')?.()

    expect(calls).toEqual(['restore', 'show', 'focus'])
    expect(clicked).toEqual(['pane-1'])
  })

  it("replaces an agent's earlier notification with its newer one", () => {
    const notify = makeAgentNotifier(
      fakeWindow({ visible: true, minimized: false, focused: false }).window,
      () => {}
    )

    notify(NOTIFICATION)
    notify({ ...NOTIFICATION, body: 'Needs input: Allow Bash ls?' })
    notify({ ...NOTIFICATION, paneId: 'pane-2' })

    expect(toasts.map((toast) => toast.closed)).toEqual([true, false, false])
  })
})

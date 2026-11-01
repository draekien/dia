import type { AgentNotification } from '@shared/domain/notification'
import { type BrowserWindow, Notification } from 'electron'

/** Whether the user can see `window`: it is shown, not minimised and focused. */
export const isWindowAttended = (window: BrowserWindow): boolean =>
  window.isVisible() && !window.isMinimized() && window.isFocused()

/**
 * Calls `report` with {@link isWindowAttended} each time `window` is focused, blurred, shown,
 * hidden, minimised or restored. Call once per window.
 */
export const watchWindowAttention = (
  window: BrowserWindow,
  report: (attended: boolean) => void
): void => {
  const onChange = (): void => report(isWindowAttended(window))
  window.on('focus', onChange)
  window.on('blur', onChange)
  window.on('show', onChange)
  window.on('hide', onChange)
  window.on('minimize', onChange)
  window.on('restore', onChange)
}

/**
 * Returns a function that shows an {@link AgentNotification} as an OS notification. Clicking it
 * restores, shows and focuses `window`, then calls `onClick` with the notification's `paneId`.
 * Each agent has at most one notification: a newer one closes the older one.
 */
export const makeAgentNotifier = (
  window: BrowserWindow,
  onClick: (paneId: string) => void
): ((notification: AgentNotification) => void) => {
  const shown = new Map<string, Notification>()
  return ({ paneId, title, body }) => {
    shown.get(paneId)?.close()
    const toast = new Notification({ title, body })
    toast.on('click', () => {
      shown.delete(paneId)
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      onClick(paneId)
    })
    shown.set(paneId, toast)
    toast.show()
  }
}

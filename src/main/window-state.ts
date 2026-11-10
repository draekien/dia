// @effect-diagnostics-next-line nodeBuiltinImport:off -- the window is created synchronously in Electron's whenReady callback, outside any Effect.
import { readFileSync, writeFileSync } from 'node:fs'
import { Option, Schema } from 'effect'
import type { BrowserWindow, Rectangle } from 'electron'

const WindowStateSchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  maximized: Schema.Boolean
})

type WindowState = typeof WindowStateSchema.Type

const decodeWindowState = Schema.decodeUnknownOption(Schema.fromJsonString(WindowStateSchema))

const MIN_VISIBLE_TITLE_BAR_WIDTH = 100

const titleBarIsDraggable = (window: Rectangle, area: Rectangle): boolean => {
  const visibleWidth =
    Math.min(window.x + window.width, area.x + area.width) - Math.max(window.x, area.x)
  return (
    visibleWidth >= MIN_VISIBLE_TITLE_BAR_WIDTH &&
    window.y >= area.y &&
    window.y < area.y + area.height
  )
}

/**
 * Decodes saved window-state JSON. Returns `None` when the JSON is malformed or no display in
 * `workAreas` (the work areas of the connected displays) shows enough of the window's title bar to
 * drag it, so a window saved on a now-disconnected monitor opens at the default position instead.
 */
export const parseWindowState = (
  json: string,
  workAreas: ReadonlyArray<Rectangle>
): Option.Option<WindowState> =>
  decodeWindowState(json).pipe(
    Option.filter((state) => workAreas.some((area) => titleBarIsDraggable(state, area)))
  )

/**
 * Reads the window state saved at `filePath` by {@link saveWindowStateOnClose}. Returns `None`
 * when the file is missing or {@link parseWindowState} rejects it.
 */
export const loadWindowState = (
  filePath: string,
  workAreas: ReadonlyArray<Rectangle>
): Option.Option<WindowState> =>
  Option.liftThrowable(() => readFileSync(filePath, 'utf8'))().pipe(
    Option.flatMap((json) => parseWindowState(json, workAreas))
  )

/**
 * Writes `window`'s normal-state bounds and maximised flag to `filePath` each time it closes.
 * Calls `onSaveFailed` with the error when the write fails; the window still closes.
 */
export const saveWindowStateOnClose = (
  window: BrowserWindow,
  filePath: string,
  onSaveFailed: (cause: unknown) => void
): void => {
  window.on('close', () => {
    const state: WindowState = { ...window.getNormalBounds(), maximized: window.isMaximized() }
    try {
      writeFileSync(filePath, JSON.stringify(state))
    } catch (cause) {
      onSaveFailed(cause)
    }
  })
}

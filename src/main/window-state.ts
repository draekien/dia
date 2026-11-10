// @effect-diagnostics-next-line nodeBuiltinImport:off -- the window is created synchronously in Electron's whenReady callback, outside any Effect.
import { readFileSync, writeFileSync } from 'node:fs'
import { Option, Schema } from 'effect'
import type { BrowserWindow, Rectangle } from 'electron'

/** The main window's normal-state bounds and whether it was maximised, as saved on close. */
export const WindowStateSchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  maximized: Schema.Boolean
})

/** A decoded {@link WindowStateSchema}. */
export type WindowState = typeof WindowStateSchema.Type

const decodeWindowState = Schema.decodeUnknownOption(Schema.fromJsonString(WindowStateSchema))

const overlaps = (a: Rectangle, b: Rectangle): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * Decodes saved window-state JSON. Returns `None` when the JSON is malformed or the saved bounds
 * overlap none of `workAreas` (the work areas of the connected displays), so a window saved on a
 * now-disconnected monitor opens at the default position instead of off-screen.
 */
export const parseWindowState = (
  json: string,
  workAreas: ReadonlyArray<Rectangle>
): Option.Option<WindowState> =>
  decodeWindowState(json).pipe(
    Option.filter((state) => workAreas.some((area) => overlaps(state, area)))
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

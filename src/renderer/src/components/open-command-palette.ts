/** The window event the command palette listens for to open. */
export const OPEN_COMMAND_PALETTE_EVENT = 'dia:open-command-palette'

/**
 * Opens the command palette from anywhere in the renderer, as Cmd/Ctrl+K does. The palette
 * responds while the `command-palette` plugin is loaded.
 */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))
}

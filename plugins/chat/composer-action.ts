import type { SendMode } from '@shared/domain/message-queue'

/**
 * What the composer's action button does. `stop` stops the running turn. `submit` sends the text
 * in `mode`; `disabled` is true when there is no text to send. `icon` is the glyph the button
 * shows and `label` its accessible name and tooltip title.
 */
export type ComposerAction =
  | { readonly kind: 'stop'; readonly icon: 'stop'; readonly label: 'Stop' }
  | {
      readonly kind: 'submit'
      readonly icon: 'queue' | 'sendNow'
      readonly label: 'Send' | 'Queue' | 'Steer now'
      readonly mode: SendMode
      readonly disabled: boolean
    }

const otherMode = (mode: SendMode): SendMode => (mode === 'queue' ? 'steer' : 'queue')

const iconFor = (mode: SendMode) => (mode === 'queue' ? 'queue' : 'sendNow')

/**
 * The action button for a composer. `running` is true while a turn runs, `hasText` when the
 * composer holds non-blank text, `modifierHeld` while Cmd (macOS) or Ctrl is held, and
 * `defaultMode` is the mode Enter sends in.
 */
export const composerAction = ({
  running,
  hasText,
  modifierHeld,
  defaultMode
}: {
  readonly running: boolean
  readonly hasText: boolean
  readonly modifierHeld: boolean
  readonly defaultMode: SendMode
}): ComposerAction => {
  if (running && !hasText) return { kind: 'stop', icon: 'stop', label: 'Stop' }
  if (!hasText) {
    return { kind: 'submit', icon: 'sendNow', label: 'Send', mode: defaultMode, disabled: true }
  }
  const mode = modifierHeld ? otherMode(defaultMode) : defaultMode
  const label = !running ? 'Send' : mode === 'queue' ? 'Queue' : 'Steer now'
  return { kind: 'submit', icon: iconFor(mode), label, mode, disabled: false }
}

/**
 * The tooltip lines for the action button: what Enter does, then how to reach the other mode.
 * `modifierKey` is the key label shown to the user, `⌘` on macOS and `Ctrl` elsewhere. Use it for
 * a `submit` action; a `stop` action's tooltip is its label alone.
 */
export const composerActionHint = ({
  running,
  defaultMode,
  modifierKey
}: {
  readonly running: boolean
  readonly defaultMode: SendMode
  readonly modifierKey: string
}): readonly [string, string] => {
  if (!running) {
    return ['Send with Enter', `${modifierKey}+Enter also sends now while no turn is running`]
  }
  return defaultMode === 'queue'
    ? ['Queue after this turn with Enter', `Hold ${modifierKey} to steer now`]
    : ['Steer this turn now with Enter', `Hold ${modifierKey} to queue after this turn`]
}

/** The composer's placeholder text while a turn is `running` or not, given the `defaultMode`. */
export const composerPlaceholder = (running: boolean, defaultMode: SendMode): string => {
  if (!running) return 'Message this agent, or type / for commands'
  return defaultMode === 'queue'
    ? 'Queue a message for after this turn, or type / for commands'
    : 'Steer this turn, or type / for commands'
}

import { DEFAULT_SEND_MODE, type SendMode } from '@shared/domain/message-queue'
import { Effect } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'

const storedSendModeAtom = Atom.make(
  Effect.promise(() => window.dia.getSendMode()).pipe(
    Effect.tap((mode) => Effect.logDebug('Loaded the default send mode', { mode }))
  )
).pipe(Atom.keepAlive)

const chosenSendModeAtom = Atom.make<SendMode | null>(null).pipe(Atom.keepAlive)

/**
 * The default {@link SendMode}: Enter sends in it, Cmd/Ctrl+Enter in the other mode. Reads
 * `'queue'` until the persisted choice loads. Set it to change and persist the default. Read with
 * `useAtomValue(sendModeAtom)`, set with `useAtomSet(sendModeAtom)`.
 */
export const sendModeAtom = Atom.writable(
  (get): SendMode =>
    get(chosenSendModeAtom) ??
    AsyncResult.getOrElse(get(storedSendModeAtom), () => DEFAULT_SEND_MODE),
  (ctx, mode: SendMode) => {
    ctx.set(chosenSendModeAtom, mode)
    void window.dia.setSendMode(mode)
  }
).pipe(Atom.keepAlive)

/**
 * The mode an Enter key press sends in: `defaultMode` for a plain Enter, and the other mode when
 * Cmd (macOS) or Ctrl (elsewhere) is held.
 */
export const sendModeForEnter = (
  defaultMode: SendMode,
  keys: { readonly metaKey: boolean; readonly ctrlKey: boolean }
): SendMode => {
  if (!keys.metaKey && !keys.ctrlKey) return defaultMode
  return defaultMode === 'queue' ? 'steer' : 'queue'
}

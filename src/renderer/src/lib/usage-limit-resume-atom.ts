import { DEFAULT_USAGE_LIMIT_RESUME, type UsageLimitResume } from '@shared/domain/parking'
import { Effect } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'

const storedUsageLimitResumeAtom = Atom.make(
  Effect.promise(() => window.dia.getUsageLimitResume()).pipe(
    Effect.tap((mode) => Effect.logDebug('Loaded the usage-limit resume mode', { mode }))
  )
).pipe(Atom.keepAlive)

const chosenUsageLimitResumeAtom = Atom.make<UsageLimitResume | null>(null).pipe(Atom.keepAlive)

/**
 * What dia does when a usage limit resets: `automatic` sends `continue` to the parked agents,
 * `manual` waits for the user. Reads `'automatic'` until the persisted choice loads. Set it to
 * change and persist the mode, which also applies to agents already parked. Read with
 * `useAtomValue(usageLimitResumeAtom)`, set with `useAtomSet(usageLimitResumeAtom)`.
 */
export const usageLimitResumeAtom = Atom.writable(
  (get): UsageLimitResume =>
    get(chosenUsageLimitResumeAtom) ??
    AsyncResult.getOrElse(get(storedUsageLimitResumeAtom), () => DEFAULT_USAGE_LIMIT_RESUME),
  (ctx, mode: UsageLimitResume) => {
    ctx.set(chosenUsageLimitResumeAtom, mode)
    void window.dia.setUsageLimitResume(mode)
  }
).pipe(Atom.keepAlive)

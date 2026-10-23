import { Context, Effect, Layer } from 'effect'

/** Number of most recent request ids remembered per pane. */
export const DEFAULT_DEDUPE_CAPACITY = 256

/**
 * Remembers the `requestId` of every command the Host accepted, per pane, so a command a client
 * resends after a reconnect is applied once. Call `accept` before applying a command and skip
 * the command when it returns `false`.
 */
export class CommandDeduper extends Context.Service<
  CommandDeduper,
  {
    /**
     * Records `requestId` for `paneId` and reports whether it is new. Returns `false` for an id
     * already accepted for that pane. Ids are remembered per pane, so the same id on another
     * pane is new. Only the most recent ids per pane are kept; an id older than that window
     * is accepted again.
     */
    readonly accept: (paneId: string, requestId: string) => Effect.Effect<boolean>
  }
>()('CommandDeduper') {}

/** Builds the live {@link CommandDeduper} layer, remembering `capacity` ids per pane. */
export const makeCommandDeduperLive = (capacity: number = DEFAULT_DEDUPE_CAPACITY) =>
  Layer.sync(CommandDeduper, () => {
    const seen = new Map<string, Set<string>>()
    const accept = (paneId: string, requestId: string): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const ids = seen.get(paneId) ?? new Set<string>()
        seen.set(paneId, ids)
        if (ids.has(requestId)) return false
        ids.add(requestId)
        if (ids.size > capacity) {
          const oldest = ids.values().next()
          if (!oldest.done) ids.delete(oldest.value)
        }
        return true
      })
    return { accept }
  })

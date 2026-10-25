import { Context, Effect, Layer } from 'effect'

/** Number of most recent request ids remembered per scope. */
export const DEFAULT_DEDUPE_CAPACITY = 256

/**
 * Remembers the `commandId` of every command the Host accepted, per scope (the pane id for a
 * pane command, the project id for a project command, `'app'` for an app setting), so a command
 * a client resends after a reconnect is applied once. Call `accept` before applying a command and skip
 * the command when it returns `false`.
 */
export class CommandDeduper extends Context.Service<
  CommandDeduper,
  {
    /**
     * Records `commandId` for `scopeId` and reports whether it is new. Returns `false` for an id
     * already accepted for that scope. Ids are remembered per scope, so the same id in another
     * scope is new. Only the most recent ids per scope are kept; an id older than that window
     * is accepted again.
     */
    readonly accept: (scopeId: string, commandId: string) => Effect.Effect<boolean>
  }
>()('CommandDeduper') {}

/** Builds the live {@link CommandDeduper} layer, remembering `capacity` ids per scope. */
export const makeCommandDeduperLive = (capacity: number = DEFAULT_DEDUPE_CAPACITY) =>
  Layer.sync(CommandDeduper, () => {
    const seen = new Map<string, Set<string>>()
    const accept = (scopeId: string, commandId: string): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const ids = seen.get(scopeId) ?? new Set<string>()
        seen.set(scopeId, ids)
        if (ids.has(commandId)) return false
        ids.add(commandId)
        if (ids.size > capacity) {
          const oldest = ids.values().next()
          if (!oldest.done) ids.delete(oldest.value)
        }
        return true
      })
    return { accept }
  })

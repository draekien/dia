import { type PendingUserInput, Superseded, type UserInputResolution } from '@dia/plugin'
import { Deferred, Effect } from 'effect'

/**
 * Creates an empty {@link PendingUserInput} registry. Each instance owns its own
 * request set, so a fresh one gives tests full isolation; a pane session
 * creates one and shares it between its `canUseTool` callback and its
 * inbound-message handler.
 */
export const makePendingUserInput = (): PendingUserInput => {
  const pending = new Map<string, Deferred.Deferred<UserInputResolution>>()

  return {
    register: (requestId) =>
      Effect.map(Deferred.make<UserInputResolution>(), (deferred) => {
        pending.set(requestId, deferred)
        return deferred
      }),
    resolve: Effect.fn('PendingUserInput.resolve')(function* (
      requestId: string,
      resolution: UserInputResolution
    ) {
      const deferred = pending.get(requestId)
      if (deferred === undefined) return false
      pending.delete(requestId)
      yield* Deferred.succeed(deferred, resolution)
      return true
    }),
    interruptAll: Effect.gen(function* () {
      const entries = [...pending.entries()]
      pending.clear()
      const superseded = Superseded.make({})
      for (const [, deferred] of entries) yield* Deferred.succeed(deferred, superseded)
      return entries.map(([requestId]) => requestId)
    }),
    drop: Effect.sync(() => {
      const requestIds = [...pending.keys()]
      pending.clear()
      return requestIds
    }),
    isPending: (requestId) => Effect.sync(() => pending.has(requestId))
  }
}

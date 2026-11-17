import type { ToolScope } from '@dia/plugin'
import { Crypto, Deferred, Effect, type Scope, Stream, SubscriptionRef } from 'effect'
import { OutsideSource, type PendingApproval, RunSource } from './calls'
import type { ApprovalAnswer, ApprovalRequest } from './tools'

interface Entry {
  readonly pending: PendingApproval
  readonly scope: ToolScope
  readonly answer: Deferred.Deferred<ApprovalAnswer>
}

/**
 * The approval requests waiting for the user.
 *
 * - `request` adds a request from `scope` and waits for its answer. It succeeds with 'declined'
 *   at once when `scope` was declined by `declineScope` or the approvals have closed. Interrupting
 *   it withdraws the request.
 * - `pending` streams the waiting requests, oldest first: the current list, then each change.
 * - `answer` answers request `id`; the first answer wins and an `id` not pending is ignored.
 * - `declineScope` declines every request whose scope is `scope` (the same object), and every
 *   later request with it.
 */
export interface Approvals {
  readonly request: (scope: ToolScope, request: ApprovalRequest) => Effect.Effect<ApprovalAnswer>
  readonly pending: Stream.Stream<ReadonlyArray<PendingApproval>>
  readonly answer: (id: string, answer: ApprovalAnswer) => Effect.Effect<void>
  readonly declineScope: (scope: ToolScope) => Effect.Effect<void>
}

const sourceOf = (scope: ToolScope) =>
  scope.runId === undefined
    ? OutsideSource.make({})
    : RunSource.make({ project: scope.project ?? null, labels: scope.labels })

/**
 * Builds an empty {@link Approvals} that lives until the calling scope closes. Closing it declines
 * every waiting request, and every request made after it.
 */
export const makeApprovals: Effect.Effect<Approvals, never, Crypto.Crypto | Scope.Scope> =
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const entries = yield* SubscriptionRef.make<ReadonlyArray<Entry>>([])
    const declined = new WeakSet<ToolScope>()
    let closed = false

    const decline = (chosen: ReadonlyArray<Entry>) =>
      Effect.forEach(chosen, (entry) => Deferred.succeed(entry.answer, 'declined'), {
        discard: true
      })

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true
        const waiting = yield* SubscriptionRef.get(entries)
        yield* decline(waiting)
        yield* Effect.logInfo('Declined every waiting approval: dia tools closed', {
          count: waiting.length
        })
      })
    )

    const add = Effect.fnUntraced(function* (scope: ToolScope, request: ApprovalRequest) {
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
      const entry: Entry = {
        pending: { id, source: sourceOf(scope), request },
        scope,
        answer: yield* Deferred.make<ApprovalAnswer>()
      }
      yield* SubscriptionRef.update(entries, (current) => [...current, entry])
      yield* Effect.logInfo('Approval requested', { id, runId: scope.runId })
      return entry
    })

    const remove = (entry: Entry) =>
      SubscriptionRef.update(entries, (current) => current.filter((other) => other !== entry))

    const request: Approvals['request'] = (scope, request) =>
      Effect.suspend(() =>
        closed || declined.has(scope)
          ? Effect.logInfo('Approval declined at once: its token was revoked or dia tools closed', {
              runId: scope.runId
            }).pipe(Effect.as<ApprovalAnswer>('declined'))
          : Effect.acquireUseRelease(
              add(scope, request),
              (entry) =>
                Deferred.await(entry.answer).pipe(
                  Effect.tap((answer) =>
                    Effect.logInfo('Approval answered', { id: entry.pending.id, answer })
                  ),
                  Effect.onInterrupt(() =>
                    Effect.logInfo('Approval withdrawn', { id: entry.pending.id })
                  )
                ),
              remove
            )
      )

    const answer: Approvals['answer'] = (id, answer) =>
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(entries)).find((one) => one.pending.id === id)
        if (entry === undefined) {
          yield* Effect.logDebug('Ignored an answer to an approval that is not waiting', { id })
          return
        }
        yield* Deferred.succeed(entry.answer, answer)
      })

    const declineScope: Approvals['declineScope'] = (scope) =>
      Effect.gen(function* () {
        declined.add(scope)
        const chosen = (yield* SubscriptionRef.get(entries)).filter(
          (entry) => entry.scope === scope
        )
        yield* decline(chosen)
        yield* Effect.logInfo('Declined the approvals of a revoked token', {
          runId: scope.runId,
          count: chosen.length
        })
      })

    return {
      request,
      pending: SubscriptionRef.changes(entries).pipe(
        Stream.map((current) => current.map((entry) => entry.pending))
      ),
      answer,
      declineScope
    }
  })

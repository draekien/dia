import type { ToolScope } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Option, Scope, Stream } from 'effect'
import { type Approvals, makeApprovals } from './approvals'
import type { PendingApproval } from './calls'

const RUN: ToolScope = { runId: 'run-1', project: 'C:/work/dia', labels: ['assistant'], context: 1 }
const CHANGE = { title: 'Change the Builder job title', before: '{}', after: '{"allow":[]}' }

const approvalsIn = (scope: Scope.Scope) =>
  makeApprovals.pipe(Scope.provide(scope), Effect.provide(NodeCrypto.layer))

const scoped = Effect.gen(function* () {
  return yield* approvalsIn(yield* Effect.scope)
})

const whenPending = (approvals: Approvals, count: number) =>
  approvals.pending.pipe(
    Stream.filter((list) => list.length === count),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  )

const requestInBackground = (approvals: Approvals, scope: ToolScope = RUN) =>
  Effect.gen(function* () {
    const before = yield* pendingCount(approvals)
    const fiber = yield* Effect.forkChild(approvals.request(scope, CHANGE))
    const list = yield* whenPending(approvals, before + 1)
    return { fiber, pending: list.at(-1) as PendingApproval }
  })

const pendingCount = (approvals: Approvals) =>
  approvals.pending.pipe(
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.map((l) => l.length)
  )

describe('makeApprovals', () => {
  for (const answer of ['approved', 'declined'] as const) {
    it.effect(`returns ${answer} after the user answers ${answer}`, () =>
      Effect.gen(function* () {
        const approvals = yield* scoped
        const { fiber, pending } = yield* requestInBackground(approvals)

        yield* approvals.answer(pending.id, answer)

        assert.strictEqual(yield* Fiber.join(fiber), answer)
      }).pipe(Effect.scoped)
    )
  }

  it.effect('keeps the first answer when the same request is answered twice', () =>
    Effect.gen(function* () {
      const approvals = yield* scoped
      const { fiber, pending } = yield* requestInBackground(approvals)

      yield* approvals.answer(pending.id, 'approved')
      yield* approvals.answer(pending.id, 'declined')

      assert.strictEqual(yield* Fiber.join(fiber), 'approved')
    }).pipe(Effect.scoped)
  )

  it.effect('ignores an answer to an id that is not pending', () =>
    Effect.gen(function* () {
      const approvals = yield* scoped
      const { pending } = yield* requestInBackground(approvals)

      yield* approvals.answer('not-a-pending-id', 'approved')

      assert.deepStrictEqual(
        (yield* whenPending(approvals, 1)).map((one) => one.id),
        [pending.id]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('lists a run request with its project and labels, and the request it shows', () =>
    Effect.gen(function* () {
      const approvals = yield* scoped

      const { pending } = yield* requestInBackground(approvals)

      assert.deepStrictEqual(pending.source, {
        _tag: 'RunSource',
        project: 'C:/work/dia',
        labels: ['assistant']
      })
      assert.deepStrictEqual(pending.request, CHANGE)
    }).pipe(Effect.scoped)
  )

  it.effect('lists a request from a scope without a run id as from outside dia', () =>
    Effect.gen(function* () {
      const approvals = yield* scoped

      const { pending } = yield* requestInBackground(approvals, { labels: [], context: undefined })

      assert.deepStrictEqual(pending.source, { _tag: 'OutsideSource' })
    }).pipe(Effect.scoped)
  )

  it.effect('lists pending requests oldest first', () =>
    Effect.gen(function* () {
      const approvals = yield* scoped
      const first = yield* requestInBackground(approvals)
      const second = yield* requestInBackground(approvals)

      const ids = (yield* whenPending(approvals, 2)).map((one) => one.id)

      assert.deepStrictEqual(ids, [first.pending.id, second.pending.id])
    }).pipe(Effect.scoped)
  )

  it.effect('declines the requests of the declined scope object and no others', () =>
    Effect.gen(function* () {
      const approvals = yield* scoped
      const revoked = yield* requestInBackground(approvals, RUN)
      const sameRunOtherToken = yield* requestInBackground(approvals, { ...RUN })

      yield* approvals.declineScope(RUN)

      assert.strictEqual(yield* Fiber.join(revoked.fiber), 'declined')
      assert.deepStrictEqual(
        (yield* whenPending(approvals, 1)).map((one) => one.id),
        [sameRunOtherToken.pending.id]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('declines at once a request under a scope declined earlier, listing nothing', () =>
    Effect.gen(function* () {
      const approvals = yield* scoped
      yield* approvals.declineScope(RUN)

      const answer = yield* approvals.request(RUN, CHANGE)

      assert.strictEqual(answer, 'declined')
      assert.strictEqual(yield* pendingCount(approvals), 0)
    }).pipe(Effect.scoped)
  )

  it.effect('declines every pending request when its scope closes', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const approvals = yield* approvalsIn(scope)
      const { fiber } = yield* requestInBackground(approvals)

      yield* Scope.close(scope, Exit.void)

      assert.strictEqual(yield* Fiber.join(fiber), 'declined')
    })
  )

  it.effect('declines at once a request made after its scope closed', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const approvals = yield* approvalsIn(scope)
      yield* Scope.close(scope, Exit.void)

      const answer = yield* approvals.request(RUN, CHANGE)

      assert.strictEqual(answer, 'declined')
    })
  )

  it.effect('dies on a request with an empty title, listing nothing', () =>
    Effect.gen(function* () {
      const approvals = yield* scoped

      const exit = yield* Effect.exit(approvals.request(RUN, { ...CHANGE, title: '' }))

      assert.isTrue(Exit.hasDies(exit))
      assert.strictEqual(yield* pendingCount(approvals), 0)
    }).pipe(Effect.scoped)
  )

  it.effect('withdraws a request whose caller is interrupted', () =>
    Effect.gen(function* () {
      const approvals = yield* scoped
      const { fiber } = yield* requestInBackground(approvals)

      yield* Fiber.interrupt(fiber)

      assert.strictEqual((yield* whenPending(approvals, 0)).length, 0)
    }).pipe(Effect.scoped)
  )
})

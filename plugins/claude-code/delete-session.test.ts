import { SessionId } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import { beforeEach, vi } from 'vitest'
import { deleteSession } from './delete-session'

const sdk = vi.hoisted(() => ({
  existing: new Set<string>(),
  deleted: [] as Array<string>,
  deleteFailure: undefined as Error | undefined
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...original,
    getSessionInfo: async (sessionId: string) =>
      sdk.existing.has(sessionId) ? { sessionId } : undefined,
    deleteSession: async (sessionId: string) => {
      if (sdk.deleteFailure !== undefined) throw sdk.deleteFailure
      if (!sdk.existing.delete(sessionId)) throw new Error(`Session ${sessionId} not found`)
      sdk.deleted.push(sessionId)
    }
  }
})

const sessionId = SessionId.make('6f1c2a50-0000-4000-8000-000000000001')

beforeEach(() => {
  sdk.existing.clear()
  sdk.deleted.length = 0
  sdk.deleteFailure = undefined
})

describe('deleteSession', () => {
  it.effect('deletes an existing transcript', () =>
    Effect.gen(function* () {
      sdk.existing.add(sessionId)

      yield* deleteSession(sessionId)

      assert.deepStrictEqual(sdk.deleted, [sessionId])
    })
  )

  it.effect('succeeds without deleting when the transcript does not exist', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(deleteSession(sessionId))

      assert.isTrue(Exit.isSuccess(exit))
      assert.deepStrictEqual(sdk.deleted, [])
    })
  )

  it.effect('succeeds when called again after a successful delete', () =>
    Effect.gen(function* () {
      sdk.existing.add(sessionId)
      yield* deleteSession(sessionId)

      const exit = yield* Effect.exit(deleteSession(sessionId))

      assert.isTrue(Exit.isSuccess(exit))
    })
  )

  it.effect('fails with SessionDeleteError when the SDK cannot delete the transcript', () =>
    Effect.gen(function* () {
      sdk.existing.add(sessionId)
      sdk.deleteFailure = new Error('EBUSY: resource busy')

      const error = yield* Effect.flip(deleteSession(sessionId))

      assert.strictEqual(error._tag, 'SessionDeleteError')
      assert.include(error.reason, 'EBUSY')
    })
  )
})

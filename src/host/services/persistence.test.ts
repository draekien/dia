import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { NoActivity, Todo } from '@shared/domain/agent-summary'
import { Effect, FileSystem } from 'effect'
import { makePersistenceServiceLive, PersistenceService } from './persistence'

const PANE_A = '11111111-1111-4111-8111-111111111111'
const PANE_B = '22222222-2222-4222-8222-222222222222'

const withPersistence = <A, E>(body: Effect.Effect<A, E, PersistenceService>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-persistence-' })
    return yield* body.pipe(Effect.provide(makePersistenceServiceLive(dir)))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('PersistenceService activity', () => {
  it.effect('loads the activity lines it saved', () =>
    withPersistence(
      Effect.gen(function* () {
        const service = yield* PersistenceService
        const activity = {
          [PANE_A]: Todo.make({ text: 'Fixing the bug' }),
          [PANE_B]: NoActivity.make({})
        }

        yield* service.saveActivity(activity)

        assert.deepStrictEqual(yield* service.loadActivity, activity)
      })
    )
  )

  it.effect('loads no activity when the file is missing', () =>
    withPersistence(
      Effect.gen(function* () {
        const service = yield* PersistenceService

        assert.deepStrictEqual(yield* service.loadActivity, {})
      })
    )
  )
})

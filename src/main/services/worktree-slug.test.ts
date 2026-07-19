import { assert, describe, it } from '@effect/vitest'
import { Effect, Random } from 'effect'
import { generateWorktreeSlug } from './worktree-slug'

describe('generateWorktreeSlug', () => {
  it.effect('produces a two-word lowercase adjective-noun slug', () =>
    Effect.gen(function* () {
      const slug = yield* generateWorktreeSlug()
      assert.match(slug, /^[a-z]+-[a-z]+$/)
    })
  )

  it.effect('is deterministic for a given Random seed', () =>
    Effect.gen(function* () {
      const first = yield* generateWorktreeSlug().pipe(
        Effect.withRandom(Random.make('seed-worktree'))
      )
      const second = yield* generateWorktreeSlug().pipe(
        Effect.withRandom(Random.make('seed-worktree'))
      )
      assert.strictEqual(first, second)
    })
  )

  it.effect('varies across different Random seeds', () =>
    Effect.gen(function* () {
      const slugs = yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], (n) =>
        generateWorktreeSlug().pipe(Effect.withRandom(Random.make(`seed-${n}`)))
      )
      assert.isAbove(new Set(slugs).size, 1)
    })
  )
})

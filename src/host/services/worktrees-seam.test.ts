import { assert, describe, it } from '@effect/vitest'
import type { WorktreeInfo } from '@shared/domain/pane'
import { Effect, Option } from 'effect'
import { type GitOps, resolveGitOps, WORKTREES_KEY } from './worktrees-seam'

const info: WorktreeInfo = { path: '/wt/a', branch: 'dia/calm-fox', sourceRepo: '/repo' }

const registryProviding = (provided: Option.Option<unknown>) => ({
  inject: (key: string) => Effect.succeed(key === WORKTREES_KEY ? provided : Option.none<unknown>())
})

const providedGitOps: GitOps = {
  createWorktree: () => Effect.succeed(info),
  removeWorktree: () => Effect.void,
  reattachWorktree: () => Effect.succeed(info)
}

describe('resolveGitOps', () => {
  it.effect('returns the GitOps the plugin provides', () =>
    Effect.gen(function* () {
      const gitOps = yield* resolveGitOps(registryProviding(Option.some(() => providedGitOps)))
      assert.strictEqual(Option.getOrThrow(gitOps), providedGitOps)
    })
  )

  const unavailableCases: ReadonlyArray<readonly [string, Option.Option<unknown>]> = [
    ['no plugin provides the service', Option.none()],
    ['the provided service is not a function', Option.some({ createWorktree: 1 })],
    ['the factory returns an object without the three operations', Option.some(() => ({}))],
    ['the factory returns null', Option.some(() => null)],
    [
      'the factory throws',
      Option.some(() => {
        throw new Error('boom')
      })
    ]
  ]

  for (const [name, provided] of unavailableCases) {
    it.effect(`returns none when ${name}`, () =>
      Effect.gen(function* () {
        const gitOps = yield* resolveGitOps(registryProviding(provided))
        assert.isTrue(Option.isNone(gitOps))
      })
    )
  }
})

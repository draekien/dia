import { assert, describe, it } from '@effect/vitest'
import type { WorktreeInfo } from '@shared/domain/pane'
import { WORKTREES_KEY } from '@shared/plugin/api'
import { Effect, Option } from 'effect'
import { type GitOps, resolveGitOps } from './worktrees-seam'

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
      const gitOps = yield* resolveGitOps(registryProviding(Option.some(providedGitOps)))
      assert.strictEqual(Option.getOrThrow(gitOps), providedGitOps)
    })
  )

  const unavailableCases: ReadonlyArray<readonly [string, Option.Option<unknown>]> = [
    ['no plugin provides the service', Option.none()],
    [
      'the service has a non-function operation',
      Option.some({ ...providedGitOps, createWorktree: 1 })
    ],
    [
      'the service lacks reattachWorktree',
      Option.some({ createWorktree: () => {}, removeWorktree: () => {} })
    ],
    ['the service is null', Option.some(null)]
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

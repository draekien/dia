import { assert, describe, it } from '@effect/vitest'
import type { WorktreeInfo } from '@shared/domain/pane'
import { Effect, Option, Result } from 'effect'
import {
  GIT_OPS_KEY,
  type GitOps,
  resolveGitOps,
  WorktreeCreateError,
  WorktreeReattachError
} from './git-ops-seam'

const PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const info: WorktreeInfo = { path: '/wt/a', branch: 'dia/calm-fox', sourceRepo: '/repo' }

const registryProviding = (provided: Option.Option<unknown>) => ({
  inject: (key: string) => Effect.succeed(key === GIT_OPS_KEY ? provided : Option.none<unknown>())
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
      assert.deepStrictEqual(yield* gitOps.createWorktree('/repo', PANE_ID, '/wt'), info)
    })
  )

  const unavailableCases: ReadonlyArray<readonly [string, Option.Option<unknown>]> = [
    ['no plugin provides the service', Option.none()],
    ['the provided service is not a function', Option.some({ createWorktree: 1 })],
    ['the factory returns an object without the three operations', Option.some(() => ({}))],
    [
      'the factory throws',
      Option.some(() => {
        throw new Error('boom')
      })
    ]
  ]

  for (const [name, provided] of unavailableCases) {
    it.effect(`refuses createWorktree and reattachWorktree when ${name}`, () =>
      Effect.gen(function* () {
        const gitOps = yield* resolveGitOps(registryProviding(provided))
        const created = yield* Effect.result(gitOps.createWorktree('/repo', PANE_ID, '/wt'))
        const reattached = yield* Effect.result(gitOps.reattachWorktree(info, PANE_ID))
        assert.isTrue(Result.isFailure(created))
        assert.isTrue(Result.isFailure(reattached))
        if (Result.isFailure(created) && Result.isFailure(reattached)) {
          assert.instanceOf(created.failure, WorktreeCreateError)
          assert.instanceOf(reattached.failure, WorktreeReattachError)
        }
      })
    )

    it.effect(`removeWorktree succeeds without removing anything when ${name}`, () =>
      Effect.gen(function* () {
        const gitOps = yield* resolveGitOps(registryProviding(provided))
        assert.isUndefined(yield* gitOps.removeWorktree(info, PANE_ID))
      })
    )
  }
})

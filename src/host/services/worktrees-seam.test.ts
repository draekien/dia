import { assert, describe, it } from '@effect/vitest'
import type { WorktreeInfo } from '@shared/domain/pane'
import { fakeUse } from '@shared/plugin/plugin-registry.fake'
import { Effect, Option } from 'effect'
import { type GitOps, WorktreesKey, withGitOps } from './worktrees-seam'

const info: WorktreeInfo = { path: '/wt/a', branch: 'dia/calm-fox', sourceRepo: '/repo' }

const registryProviding = (provided: Option.Option<unknown>) => ({
  use: fakeUse((key) => (key === WorktreesKey.name ? provided : Option.none()))
})

const providedGitOps: GitOps = {
  createWorktree: () => Effect.succeed(info),
  removeWorktree: () => Effect.void,
  reattachWorktree: () => Effect.succeed(info),
  findIncludedFiles: () => Effect.succeed(Option.none()),
  copyIncludedFiles: () => Effect.succeed([])
}

describe('withGitOps', () => {
  it.effect('runs f with the GitOps the plugin provides', () =>
    Effect.gen(function* () {
      const result = yield* withGitOps(registryProviding(Option.some(providedGitOps)), (gitOps) =>
        Effect.succeed(gitOps)
      )
      assert.strictEqual(Option.getOrThrow(result), providedGitOps)
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
    [
      'the service lacks the include operations of an older worktrees plugin',
      Option.some({
        createWorktree: () => {},
        removeWorktree: () => {},
        reattachWorktree: () => {}
      })
    ],
    ['the service is null', Option.some(null)]
  ]

  for (const [name, provided] of unavailableCases) {
    it.effect(`returns none without running f when ${name}`, () =>
      Effect.gen(function* () {
        let calls = 0
        const result = yield* withGitOps(registryProviding(provided), () =>
          Effect.sync(() => ++calls)
        )
        assert.deepStrictEqual([result, calls], [Option.none(), 0])
      })
    )
  }
})

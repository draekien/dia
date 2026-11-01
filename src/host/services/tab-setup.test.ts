import { assert, describe, it } from '@effect/vitest'
import type { WorktreeInfo } from '@shared/domain/pane'
import type { IpcEvent } from '@shared/ipc/contract'
import { Effect, Option } from 'effect'
import { setUpWorktreeTab } from './tab-setup'
import type { GitOps } from './worktrees-seam'

const paneId = '5b0c5a8e-4f0e-4f57-9d0b-0c6f6f3c2a11'

const worktree: WorktreeInfo = {
  path: '/wt/quiet-otter',
  branch: 'dia/quiet-otter',
  sourceRepo: '/a'
}

const gitOps: GitOps = {
  createWorktree: () => Effect.die(new Error('createWorktree is not called by tab setup')),
  removeWorktree: () => Effect.void,
  reattachWorktree: () => Effect.die(new Error('reattachWorktree is not called by tab setup')),
  findIncludedFiles: () => Effect.succeed(Option.none()),
  copyIncludedFiles: () => Effect.succeed([])
}

describe('setUpWorktreeTab', () => {
  it.effect('fails the session step when the session start dies', () =>
    Effect.gen(function* () {
      const events: Array<IpcEvent> = []
      const setup = yield* setUpWorktreeTab({
        paneId,
        sourceRepo: '/a',
        reattach: false,
        gitOps,
        acquire: Effect.succeed(worktree),
        emit: (event) => Effect.sync(() => void events.push(event))
      })

      yield* setup.startSession(Effect.die(new Error('backend crashed'))).pipe(Effect.exit)

      const last = events
        .flatMap((event) => (event._tag === 'PaneSetupProgress' ? [event.steps] : []))
        .at(-1)
      assert.deepStrictEqual(last?.at(-1), {
        _tag: 'SessionSetupStep',
        state: 'failed',
        error: 'The Claude Code session could not be started.'
      })
    }).pipe(Effect.scoped)
  )
})

import type { PathsMoved } from '@dia/plugin'
import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Path } from 'effect'

/**
 * Prepares the meta folder for its move (the `before` step of the `1_dia_prefix` data migration
 * in `plugin.json`): stops the meta repo's `git fsmonitor--daemon`, which holds the folder open
 * on Windows. A repo without a daemon is skipped.
 */
const beforeMove = (move: PathsMoved) =>
  Effect.gen(function* () {
    const directory = (yield* Path.Path).join(move.from, 'repo')
    yield* (yield* makeGit).stopFsmonitor(directory)
    yield* Effect.logDebug('Asked git to stop the meta repo fsmonitor daemon', { directory })
  }).pipe(Effect.provide(NodeServices.layer))

export default beforeMove

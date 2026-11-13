import type { PathsMoved } from '@dia/plugin'
import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Path } from 'effect'
import { stopFsmonitors } from './folder-move'

/**
 * Prepares the worktrees folder for its move (the `before` step of the `1_dia_prefix` data
 * migration in `plugin.json`): stops the fsmonitor daemon of every worktree under `trees`.
 */
const beforeMove = (move: PathsMoved) =>
  Effect.gen(function* () {
    yield* stopFsmonitors((yield* Path.Path).join(move.from, 'trees'), yield* makeGit)
  }).pipe(Effect.provide(NodeServices.layer))

export default beforeMove

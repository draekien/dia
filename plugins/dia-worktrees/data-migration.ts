import type { PathsMoved } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Path } from 'effect'
import { stopFsmonitors } from './folder-move'

/**
 * Prepares the worktrees folder for its move (the `before` step of the `1_dia_prefix` data
 * migration in `plugin.json`): stops the fsmonitor daemon of every worktree under `trees`.
 */
const beforeMove = (move: PathsMoved) =>
  Effect.gen(function* () {
    yield* stopFsmonitors((yield* Path.Path).join(move.from, 'trees'))
  }).pipe(Effect.provide(NodeServices.layer))

export default beforeMove

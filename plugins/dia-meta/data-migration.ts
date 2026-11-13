import type { PathsMoved } from '@dia/plugin'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

/**
 * Prepares the meta folder for its move (the `before` step of the `1_dia_prefix` data migration
 * in `plugin.json`): stops the meta repo's `git fsmonitor--daemon`, which holds the folder open
 * on Windows. A repo without a daemon is skipped.
 */
const beforeMove = (move: PathsMoved) =>
  Effect.gen(function* () {
    const directory = (yield* Path.Path).join(move.from, 'repo')
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make('git', ['fsmonitor--daemon', 'stop']).pipe(ChildProcess.setCwd(directory))
      )
      .pipe(Effect.orElseSucceed(() => -1))
    yield* Effect.logDebug('Asked git to stop the meta repo fsmonitor daemon', {
      directory,
      exitCode
    })
  }).pipe(Effect.provide(NodeServices.layer))

export default beforeMove

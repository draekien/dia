import type { PluginServices } from '@dia/plugin'
import { callHost, followHost } from '@dia/renderer-plugin'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import { FollowRunPullRequests, RefreshPullRequest, UnlinkPullRequest } from './calls'
import type { PullRequestUrl } from './pull-request-url'

/**
 * The renderer's state for the `dia-pull-requests` renderer entry `ctx`. Make it once in
 * `renderer.ts` and pass it to the card and the panel, so both read the same atoms.
 *
 * - `runPullRequests(runId)` follows the run's linked pull requests from the host.
 * - `shown(paneId)` is the pull request the panel shows in that tab; unset, or naming one that is
 *   no longer linked, shows the first.
 * - `unlink` and `refresh` ask the host to unlink or re-read a pull request; they resolve when the
 *   host has answered, and log a failure instead of rejecting.
 */
export const makePullRequestAtoms = (ctx: Pick<PluginServices, 'name'>) => {
  const run = (effect: Effect.Effect<void, unknown>, action: string, runId: string) =>
    Effect.runPromise(
      effect.pipe(
        Effect.tap(() => Effect.logDebug(`Pull request ${action} answered`, { runId })),
        Effect.catch((error) =>
          Effect.logWarning(`Pull request ${action} failed`, { runId, error: String(error) })
        )
      )
    )
  return {
    runPullRequests: Atom.family((runId: string) =>
      Atom.make(followHost(ctx, FollowRunPullRequests, { runId }))
    ),
    shown: Atom.family((_paneId: string) =>
      Atom.make<PullRequestUrl | undefined>(undefined).pipe(Atom.keepAlive)
    ),
    unlink: (runId: string, url: PullRequestUrl) =>
      run(callHost(ctx, UnlinkPullRequest, { runId, url }), 'unlink', runId),
    refresh: (runId: string, url: PullRequestUrl) =>
      run(callHost(ctx, RefreshPullRequest, { runId, url }), 'refresh', runId)
  }
}

/** The renderer state {@link makePullRequestAtoms} makes. */
export type PullRequestAtoms = ReturnType<typeof makePullRequestAtoms>

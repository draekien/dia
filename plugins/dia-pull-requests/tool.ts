import { type DiaToolResult, diaTool } from '@dia/plugin'
import { Effect, Result, Schema } from 'effect'
import { PullRequestUrl, pullRequestLabel } from './pull-request-url'
import type { PullRequests } from './pull-requests'

const decodeUrl = Schema.decodeUnknownResult(PullRequestUrl)

const result = (text: string, isError = false): DiaToolResult => ({ text, isError })

/** The `link_pull_request` dia tool over `pullRequests`; register it with `when: isRunScope`. */
export const linkPullRequestTool = (pullRequests: PullRequests) =>
  diaTool({
    name: 'link_pull_request',
    description:
      'Link a GitHub pull request to this run, so the user sees it in the Pull requests card. Call it once after you open a pull request, with its URL.',
    input: Schema.Struct({
      url: Schema.String.annotate({
        description: 'The pull request URL, https://github.com/<owner>/<repo>/pull/<number>.'
      })
    }),
    run: Effect.fn('LinkPullRequest.run')(function* (input, scope) {
      if (scope.runId === undefined) return result('link_pull_request needs a dia run.', true)
      const decoded = decodeUrl(input.url)
      if (Result.isFailure(decoded)) {
        return result(
          `Not a GitHub pull request URL: ${input.url}. Pass https://github.com/<owner>/<repo>/pull/<number>.`,
          true
        )
      }
      const url = decoded.success
      const added = yield* pullRequests.link(scope.runId, url)
      yield* Effect.logInfo('link_pull_request called', { runId: scope.runId, url, added })
      return result(
        added ? `Linked ${pullRequestLabel(url)}.` : `${pullRequestLabel(url)} is already linked.`
      )
    })
  })

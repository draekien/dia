import type { LinkedPullRequest, PullRequestCheck, PullRequestDetails } from './calls'
import { pullRequestRef } from './pull-request-url'

const STATE_LABELS: Record<PullRequestDetails['state'], string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

/** The label of a pull request state, such as `Open` or `Merged`. */
export const stateLabel = (state: PullRequestDetails['state']): string => STATE_LABELS[state]

/**
 * One phrase for a pull request's checks: `2 checks failing` when any failed, else `checks pending`
 * when any is pending, else `checks passing`; `undefined` when it has no checks or only skipped ones.
 */
export const checksSummary = (checks: ReadonlyArray<PullRequestCheck>): string | undefined => {
  const failing = checks.filter((check) => check.state === 'failed').length
  if (failing > 0) return failing === 1 ? '1 check failing' : `${failing} checks failing`
  if (checks.some((check) => check.state === 'pending')) return 'checks pending'
  if (checks.some((check) => check.state === 'passed')) return 'checks passing'
  return undefined
}

/**
 * The two lines a card row shows for `pullRequest`: `name` (`#295`, then the title once read) and
 * the muted `detail` (the repository while reading; once read, the state, followed by the checks
 * while it is open or a draft; or the failure message).
 */
export const cardLines = (
  pullRequest: LinkedPullRequest
): { readonly name: string; readonly detail: string } => {
  const { owner, repo, number } = pullRequestRef(pullRequest.url)
  const read = pullRequest.read
  switch (read._tag) {
    case 'Reading':
      return { name: `#${number}`, detail: `${owner}/${repo}` }
    case 'ReadFailed':
      return { name: `#${number}`, detail: read.message }
    case 'Read': {
      const { state: current, checks: all } = read.details
      const checks = current === 'open' || current === 'draft' ? checksSummary(all) : undefined
      const state = stateLabel(current)
      return {
        name: `#${number} ${read.details.title}`,
        detail: checks === undefined ? state : `${state}, ${checks}`
      }
    }
  }
}

import { Array as Arr, DateTime, Duration, Effect, Order, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import {
  type PullRequestActivity,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetails,
  PullRequestReview
} from './calls'
import type { PullRequestUrl } from './pull-request-url'

/** `gh` could not read the pull request. `message` is one line for the user. */
export class GhFailed extends Schema.TaggedError<GhFailed>()('GhFailed', {
  message: Schema.String
}) {}

/** Reads pull requests from GitHub. */
export interface GitHubCli {
  /** The details of the pull request at `url`, or {@link GhFailed} when `gh` cannot read it. */
  readonly view: (url: PullRequestUrl) => Effect.Effect<PullRequestDetails, GhFailed>
}

/** How long one `gh` process may run before it is killed and the read fails. */
export const GH_TIMEOUT = Duration.seconds(30)

const FORCE_KILL_AFTER = Duration.seconds(5)
const NOT_LOGGED_IN_EXIT_CODE = 4

const FIELDS = [
  'number',
  'title',
  'state',
  'isDraft',
  'author',
  'baseRefName',
  'headRefName',
  'additions',
  'deletions',
  'body',
  'reviewDecision',
  'statusCheckRollup',
  'reviews',
  'comments'
].join(',')

const Login = Schema.Struct({ login: Schema.String })

const GhCheckRun = Schema.Struct({
  __typename: Schema.Literal('CheckRun'),
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.String,
  detailsUrl: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const GhStatusContext = Schema.Struct({
  __typename: Schema.Literal('StatusContext'),
  context: Schema.String,
  state: Schema.Literals(['SUCCESS', 'PENDING', 'EXPECTED', 'ERROR', 'FAILURE']),
  targetUrl: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const GhReview = Schema.Struct({
  author: Schema.NullOr(Login),
  state: Schema.Literals(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
  body: Schema.String,
  submittedAt: Schema.NullOr(Schema.DateTimeUtcFromString)
})

const GhComment = Schema.Struct({
  author: Schema.NullOr(Login),
  body: Schema.String,
  createdAt: Schema.DateTimeUtcFromString
})

const GhPullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: Schema.Boolean,
  author: Schema.NullOr(Login),
  baseRefName: Schema.String,
  headRefName: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
  body: Schema.String,
  reviewDecision: Schema.Literals(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', '']),
  statusCheckRollup: Schema.NullOr(Schema.Array(Schema.Union([GhCheckRun, GhStatusContext]))),
  reviews: Schema.Array(GhReview),
  comments: Schema.Array(GhComment)
})
type GhPullRequest = typeof GhPullRequest.Type

const decodeGhPullRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(GhPullRequest))

const GHOST = 'ghost'

const loginOf = (author: { readonly login: string } | null): string => author?.login ?? GHOST

const withUrl = (url: string | null | undefined) =>
  url === null || url === undefined || url === '' ? {} : { url }

const checkRunState = (run: typeof GhCheckRun.Type): PullRequestCheck['state'] => {
  if (run.status !== 'COMPLETED') return 'pending'
  if (run.conclusion === 'SUCCESS' || run.conclusion === 'NEUTRAL') return 'passed'
  if (run.conclusion === 'SKIPPED' || run.conclusion === 'STALE') return 'skipped'
  return 'failed'
}

const statusContextState: Record<typeof GhStatusContext.Type.state, PullRequestCheck['state']> = {
  SUCCESS: 'passed',
  PENDING: 'pending',
  EXPECTED: 'pending',
  ERROR: 'failed',
  FAILURE: 'failed'
}

const toCheck = (check: typeof GhCheckRun.Type | typeof GhStatusContext.Type): PullRequestCheck =>
  check.__typename === 'CheckRun'
    ? PullRequestCheck.make({
        name: check.name,
        state: checkRunState(check),
        ...withUrl(check.detailsUrl)
      })
    : PullRequestCheck.make({
        name: check.context,
        state: statusContextState[check.state],
        ...withUrl(check.targetUrl)
      })

const reviewState = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed'
} as const

const toReview = (review: typeof GhReview.Type): ReadonlyArray<PullRequestActivity> =>
  review.state === 'PENDING' || review.submittedAt === null
    ? []
    : [
        PullRequestReview.make({
          author: loginOf(review.author),
          state: reviewState[review.state],
          body: review.body,
          at: DateTime.toEpochMillis(review.submittedAt)
        })
      ]

const toComment = (comment: typeof GhComment.Type): PullRequestActivity =>
  PullRequestComment.make({
    author: loginOf(comment.author),
    body: comment.body,
    at: DateTime.toEpochMillis(comment.createdAt)
  })

const byTime = Order.mapInput(Order.Number, (activity: PullRequestActivity) => activity.at)

const stateOf = (pullRequest: GhPullRequest): PullRequestDetails['state'] => {
  if (pullRequest.state === 'MERGED') return 'merged'
  if (pullRequest.state === 'CLOSED') return 'closed'
  return pullRequest.isDraft ? 'draft' : 'open'
}

const reviewDecision = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required'
} as const

const reviewDecisionOf = (decision: GhPullRequest['reviewDecision']) =>
  decision === '' ? {} : { reviewDecision: reviewDecision[decision] }

const toDetails = (pullRequest: GhPullRequest): PullRequestDetails =>
  PullRequestDetails.make({
    number: pullRequest.number,
    title: pullRequest.title,
    state: stateOf(pullRequest),
    author: loginOf(pullRequest.author),
    baseRef: pullRequest.baseRefName,
    headRef: pullRequest.headRefName,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    body: pullRequest.body,
    ...reviewDecisionOf(pullRequest.reviewDecision),
    checks: (pullRequest.statusCheckRollup ?? []).map(toCheck),
    activity: Arr.sort(
      [...pullRequest.reviews.flatMap(toReview), ...pullRequest.comments.map(toComment)],
      byTime
    )
  })

interface Output {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? 'GitHub CLI failed'

const failureOf = (output: Output): GhFailed =>
  new GhFailed({
    message:
      output.exitCode === NOT_LOGGED_IN_EXIT_CODE
        ? 'GitHub CLI is not logged in. Run gh auth login.'
        : firstLine(output.stderr)
  })

/**
 * A {@link GitHubCli} that runs `gh pr view <url> --json <fields>` through the platform
 * `ChildProcessSpawner`, with `GH_PROMPT_DISABLED=1`. It works from any working directory. A
 * process still running after {@link GH_TIMEOUT} is killed and the read fails.
 */
export const makeGitHubCli = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const run = (url: PullRequestUrl): Effect.Effect<Output, GhFailed> =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make('gh', ['pr', 'view', url, '--json', FIELDS], {
              env: { GH_PROMPT_DISABLED: '1' },
              extendEnv: true,
              forceKillAfter: FORCE_KILL_AFTER
            })
          )
          .pipe(
            Effect.mapError(() => new GhFailed({ message: 'GitHub CLI (gh) is not installed' }))
          )
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode
          ],
          { concurrency: 'unbounded' }
        ).pipe(Effect.mapError((error) => new GhFailed({ message: String(error) })))
        return { exitCode: Number(exitCode), stdout, stderr } satisfies Output
      })
    ).pipe(
      Effect.timeoutOrElse({
        duration: GH_TIMEOUT,
        orElse: () => Effect.fail(new GhFailed({ message: 'GitHub CLI timed out' }))
      })
    )

  const view = (url: PullRequestUrl): Effect.Effect<PullRequestDetails, GhFailed> =>
    Effect.gen(function* () {
      const output = yield* run(url)
      if (output.exitCode !== 0) return yield* failureOf(output)
      const decoded = yield* decodeGhPullRequest(output.stdout).pipe(
        Effect.tapError((error) =>
          Effect.logWarning('Could not decode gh pr view output', { url, error: error.message })
        ),
        Effect.mapError(() => new GhFailed({ message: 'Could not read the GitHub CLI output' }))
      )
      return toDetails(decoded)
    }).pipe(
      Effect.tap(() => Effect.logDebug('Read a pull request with gh', { url })),
      Effect.tapError((error) =>
        Effect.logDebug('gh could not read a pull request', { url, message: error.message })
      )
    )

  return { view } satisfies GitHubCli
})

import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Fiber, Layer, PlatformError, Schema, Sink, Stream } from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'
import { GH_TIMEOUT, GhFailed, makeGitHubCli } from './gh'
import { PullRequestUrl } from './pull-request-url'

const URL = Schema.decodeSync(PullRequestUrl)('https://github.com/draekien/dia/pull/295')

const bytes = (text: string) => Stream.make(new TextEncoder().encode(text))

const processWith = (options: {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly exit?: Effect.Effect<void>
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: (options.exit ?? Effect.void).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(options.exitCode ?? 0))
    ),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: bytes(options.stdout ?? ''),
    stderr: bytes(options.stderr ?? ''),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void)
  })

const spawning = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.succeed(handle))
  )

const notInstalled = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.fail(
      PlatformError.systemError({ _tag: 'NotFound', module: 'ChildProcess', method: 'spawn' })
    )
  )
)

const view = (layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.flatMap(makeGitHubCli, (gh) => gh.view(URL)).pipe(Effect.provide(layer))

const printed = (json: object) => spawning(processWith({ stdout: JSON.stringify(json) }))

const OPEN_PULL_REQUEST = {
  number: 295,
  title: 'feat: link pull requests',
  state: 'OPEN',
  isDraft: false,
  author: { id: 'U_1', is_bot: false, login: 'octocat', name: 'Octo Cat' },
  baseRefName: 'main',
  headRefName: 'feat/link-pull-requests',
  additions: 120,
  deletions: 34,
  body: 'Adds the card.',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [],
  reviews: [],
  comments: []
}

const checkRun = (status: string, conclusion: string) => ({
  __typename: 'CheckRun',
  name: 'build',
  workflowName: 'CI',
  status,
  conclusion,
  startedAt: '2026-11-16T14:04:22Z',
  completedAt: '2026-11-16T14:05:00Z',
  detailsUrl: 'https://github.com/draekien/dia/actions/runs/1/job/2'
})

const statusContext = (state: string) => ({
  __typename: 'StatusContext',
  context: 'deploy',
  state,
  targetUrl: 'https://deploy.example/1',
  startedAt: '2026-11-16T14:04:22Z'
})

const failureMessage = (layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  view(layer).pipe(
    Effect.flip,
    Effect.map((error) => error.message)
  )

describe('makeGitHubCli', () => {
  it.effect('maps the summary fields of an open pull request', () =>
    Effect.gen(function* () {
      const details = yield* view(printed(OPEN_PULL_REQUEST))
      assert.deepStrictEqual(
        {
          number: details.number,
          title: details.title,
          state: details.state,
          author: details.author,
          baseRef: details.baseRef,
          headRef: details.headRef,
          additions: details.additions,
          deletions: details.deletions,
          body: details.body,
          reviewDecision: details.reviewDecision
        },
        {
          number: 295,
          title: 'feat: link pull requests',
          state: 'open',
          author: 'octocat',
          baseRef: 'main',
          headRef: 'feat/link-pull-requests',
          additions: 120,
          deletions: 34,
          body: 'Adds the card.',
          reviewDecision: 'review_required'
        }
      )
    })
  )

  it.effect.each([
    ['OPEN', true, 'draft'],
    ['OPEN', false, 'open'],
    ['MERGED', false, 'merged'],
    ['CLOSED', false, 'closed']
  ] as const)('reads state %s with isDraft %s as %s', ([state, isDraft, expected]) =>
    Effect.gen(function* () {
      const details = yield* view(printed({ ...OPEN_PULL_REQUEST, state, isDraft }))
      assert.strictEqual(details.state, expected)
    })
  )

  it.effect('leaves the review decision out when GitHub reports none', () =>
    Effect.gen(function* () {
      const details = yield* view(printed({ ...OPEN_PULL_REQUEST, reviewDecision: '' }))
      assert.isFalse('reviewDecision' in details)
    })
  )

  it.effect('reads a null status check rollup as no checks', () =>
    Effect.gen(function* () {
      const details = yield* view(printed({ ...OPEN_PULL_REQUEST, statusCheckRollup: null }))
      assert.deepStrictEqual(details.checks, [])
    })
  )

  it.effect.each([
    ['IN_PROGRESS', '', 'pending'],
    ['QUEUED', '', 'pending'],
    ['COMPLETED', 'SUCCESS', 'passed'],
    ['COMPLETED', 'NEUTRAL', 'passed'],
    ['COMPLETED', 'SKIPPED', 'skipped'],
    ['COMPLETED', 'STALE', 'skipped'],
    ['COMPLETED', 'FAILURE', 'failed'],
    ['COMPLETED', 'TIMED_OUT', 'failed'],
    ['COMPLETED', 'CANCELLED', 'failed']
  ] as const)('reads a check run %s with conclusion "%s" as %s', ([status, conclusion, expected]) =>
    Effect.gen(function* () {
      const details = yield* view(
        printed({ ...OPEN_PULL_REQUEST, statusCheckRollup: [checkRun(status, conclusion)] })
      )
      assert.deepStrictEqual(details.checks, [
        {
          name: 'build',
          state: expected,
          url: 'https://github.com/draekien/dia/actions/runs/1/job/2'
        }
      ])
    })
  )

  it.effect.each([
    ['SUCCESS', 'passed'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
    ['ERROR', 'failed'],
    ['FAILURE', 'failed']
  ] as const)('reads a status context %s as %s', ([state, expected]) =>
    Effect.gen(function* () {
      const details = yield* view(
        printed({ ...OPEN_PULL_REQUEST, statusCheckRollup: [statusContext(state)] })
      )
      assert.deepStrictEqual(details.checks, [
        { name: 'deploy', state: expected, url: 'https://deploy.example/1' }
      ])
    })
  )

  it.effect('merges reviews and comments in time order and leaves out pending reviews', () =>
    Effect.gen(function* () {
      const details = yield* view(
        printed({
          ...OPEN_PULL_REQUEST,
          reviews: [
            {
              author: { login: 'reviewer' },
              state: 'APPROVED',
              body: 'Looks good.',
              submittedAt: '2026-11-17T10:00:00Z'
            },
            {
              author: { login: 'drafter' },
              state: 'PENDING',
              body: 'Not sent.',
              submittedAt: null
            }
          ],
          comments: [
            {
              author: { login: 'octocat' },
              body: 'First.',
              createdAt: '2026-11-17T09:00:00Z'
            },
            { author: null, body: 'Last.', createdAt: '2026-11-17T11:00:00Z' }
          ]
        })
      )
      assert.deepStrictEqual(details.activity, [
        {
          _tag: 'Comment',
          author: 'octocat',
          body: 'First.',
          at: Date.UTC(2026, 10, 17, 9)
        },
        {
          _tag: 'Review',
          author: 'reviewer',
          state: 'approved',
          body: 'Looks good.',
          at: Date.UTC(2026, 10, 17, 10)
        },
        { _tag: 'Comment', author: 'ghost', body: 'Last.', at: Date.UTC(2026, 10, 17, 11) }
      ])
    })
  )

  it.effect('reports that gh is not installed when it cannot start', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* failureMessage(notInstalled), 'GitHub CLI (gh) is not installed')
    })
  )

  it.effect('reports that gh is not logged in on exit code 4', () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(
        spawning(
          processWith({
            exitCode: 4,
            stderr: 'To get started with GitHub CLI, please run:  gh auth login\n'
          })
        )
      )
      assert.strictEqual(message, 'GitHub CLI is not logged in. Run gh auth login.')
    })
  )

  it.effect('reports the first stderr line on any other failure', () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(
        spawning(
          processWith({
            exitCode: 1,
            stderr:
              '\nGraphQL: Could not resolve to a PullRequest with the number of 295. (repository.pullRequest)\nmore\n'
          })
        )
      )
      assert.strictEqual(
        message,
        'GraphQL: Could not resolve to a PullRequest with the number of 295. (repository.pullRequest)'
      )
    })
  )

  it.effect('reports output it cannot decode', () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(printed({ ...OPEN_PULL_REQUEST, state: 'ARCHIVED' }))
      assert.strictEqual(message, 'Could not read the GitHub CLI output')
    })
  )

  it.effect('fails a gh process that is still running after the timeout', () =>
    Effect.gen(function* () {
      const fiber = yield* view(spawning(processWith({ exit: Effect.never }))).pipe(
        Effect.flip,
        Effect.forkChild
      )
      yield* TestClock.adjust(Duration.sum(GH_TIMEOUT, Duration.seconds(1)))
      const error = yield* Fiber.join(fiber)
      assert.instanceOf(error, GhFailed)
      assert.strictEqual(error.message, 'GitHub CLI timed out')
    })
  )
})

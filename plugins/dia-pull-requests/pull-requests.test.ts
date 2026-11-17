import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Fiber, Option, Ref, Schema, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { openDatabase } from '../../src/host/services/database'
import { type LinkedPullRequest, PullRequestDetails } from './calls'
import { GhFailed, type GitHubCli } from './gh'
import { PullRequestUrl } from './pull-request-url'
import { makePullRequests, POLL_INTERVAL, type PullRequests } from './pull-requests'
import { type LinkStore, makeLinkStore, pullRequestMigrations } from './store'

const url = (number: number) =>
  Schema.decodeSync(PullRequestUrl)(`https://github.com/draekien/dia/pull/${number}`)

const RUN = 'run-1'

type Answer = PullRequestDetails['state'] | { readonly fails: string }

const details = (state: PullRequestDetails['state']) =>
  PullRequestDetails.make({
    number: 1,
    title: 'feat: link pull requests',
    state,
    author: 'octocat',
    baseRef: 'main',
    headRef: 'feat/link',
    additions: 1,
    deletions: 0,
    body: '',
    checks: [],
    activity: []
  })

const fakeGh = Effect.gen(function* () {
  const answers = yield* Ref.make(new Map<string, Answer>())
  const reads = yield* Ref.make(new Map<string, number>())
  const gh: GitHubCli = {
    view: (pullRequest) =>
      Effect.gen(function* () {
        yield* Ref.update(reads, (counts) =>
          new Map(counts).set(pullRequest, (counts.get(pullRequest) ?? 0) + 1)
        )
        const answer = (yield* Ref.get(answers)).get(pullRequest) ?? 'open'
        if (typeof answer === 'string') return details(answer)
        return yield* new GhFailed({ message: answer.fails })
      })
  }
  return {
    gh,
    answer: (pullRequest: PullRequestUrl, value: Answer) =>
      Ref.update(answers, (current) => new Map(current).set(pullRequest, value)),
    readsOf: (pullRequest: PullRequestUrl) =>
      Effect.map(Ref.get(reads), (counts) => counts.get(pullRequest) ?? 0)
  }
})

const setUp = Effect.gen(function* () {
  const sql = yield* openDatabase(':memory:', pullRequestMigrations)
  const store = yield* makeLinkStore.pipe(Effect.provideService(SqlClient.SqlClient, sql))
  const fake = yield* fakeGh
  const pullRequests = yield* makePullRequests(store, fake.gh)
  return { store, ...fake, pullRequests }
})

const firstMatching = (
  pullRequests: PullRequests,
  done: (links: ReadonlyArray<LinkedPullRequest>) => boolean
) =>
  pullRequests.follow(RUN).pipe(Stream.filter(done), Stream.runHead, Effect.map(Option.getOrThrow))

const settled = (pullRequests: PullRequests) =>
  firstMatching(pullRequests, (links) => links.every((entry) => entry.read._tag !== 'Reading'))

const current = (pullRequests: PullRequests) => firstMatching(pullRequests, () => true)

const following = (pullRequests: PullRequests) =>
  Effect.forkChild(Stream.runDrain(pullRequests.follow(RUN)))

const afterPolls = (count: number) => TestClock.adjust(Duration.times(POLL_INTERVAL, count))

describe('PullRequests', () => {
  it.effect('a new link shows Reading, then the details gh read (success criterion 1)', () =>
    Effect.gen(function* () {
      const { pullRequests } = yield* setUp
      const added = yield* pullRequests.link(RUN, url(1))
      const settledLinks = yield* settled(pullRequests)
      assert.isTrue(added)
      assert.deepStrictEqual(
        settledLinks.map((entry) => [entry.url, entry.read._tag]),
        [[url(1), 'Read']]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('linking the same URL twice keeps one entry (success criterion 3)', () =>
    Effect.gen(function* () {
      const { pullRequests } = yield* setUp
      const first = yield* pullRequests.link(RUN, url(1))
      const second = yield* pullRequests.link(RUN, url(1))
      const links = yield* settled(pullRequests)
      assert.deepStrictEqual([first, second], [true, false])
      assert.deepStrictEqual(
        links.map((entry) => entry.url),
        [url(1)]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('keeps links in the order they were made', () =>
    Effect.gen(function* () {
      const { pullRequests } = yield* setUp
      yield* pullRequests.link(RUN, url(2))
      yield* TestClock.adjust('1 second')
      yield* pullRequests.link(RUN, url(1))
      const links = yield* settled(pullRequests)
      assert.deepStrictEqual(
        links.map((entry) => entry.url),
        [url(2), url(1)]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('a failed read shows the gh message (success criterion 10)', () =>
    Effect.gen(function* () {
      const { pullRequests, answer } = yield* setUp
      yield* answer(url(1), { fails: 'GitHub CLI (gh) is not installed' })
      yield* pullRequests.link(RUN, url(1))
      const [entry] = yield* settled(pullRequests)
      assert.deepStrictEqual(entry?.read, {
        _tag: 'ReadFailed',
        message: 'GitHub CLI (gh) is not installed'
      })
    }).pipe(Effect.scoped)
  )

  it.effect(
    'unlink removes the pull request from the run and the store (success criterion 9)',
    () =>
      Effect.gen(function* () {
        const { pullRequests, store } = yield* setUp
        yield* pullRequests.link(RUN, url(1))
        yield* pullRequests.link(RUN, url(2))
        yield* settled(pullRequests)
        yield* pullRequests.unlink(RUN, url(1))
        const links = yield* current(pullRequests)
        assert.deepStrictEqual(
          links.map((entry) => entry.url),
          [url(2)]
        )
        assert.deepStrictEqual(yield* store.list(RUN), [url(2)])
      }).pipe(Effect.scoped)
  )

  it.effect('loads stored links on first use and reads each once', () =>
    Effect.gen(function* () {
      const sql = yield* openDatabase(':memory:', pullRequestMigrations)
      const store: LinkStore = yield* makeLinkStore.pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )
      yield* store.link(RUN, url(1))
      const { gh, readsOf } = yield* fakeGh
      const pullRequests = yield* makePullRequests(store, gh)
      const links = yield* settled(pullRequests)
      assert.deepStrictEqual(
        links.map((entry) => [entry.url, entry.read._tag]),
        [[url(1), 'Read']]
      )
      assert.strictEqual(yield* readsOf(url(1)), 1)
    }).pipe(Effect.scoped)
  )

  it.effect('refresh reads a merged pull request again', () =>
    Effect.gen(function* () {
      const { pullRequests, answer, readsOf } = yield* setUp
      yield* answer(url(1), 'merged')
      yield* pullRequests.link(RUN, url(1))
      yield* settled(pullRequests)
      yield* pullRequests.refresh(RUN, url(1))
      assert.strictEqual(yield* readsOf(url(1)), 2)
    }).pipe(Effect.scoped)
  )

  it.effect('refresh of an unlinked URL reads nothing', () =>
    Effect.gen(function* () {
      const { pullRequests, readsOf } = yield* setUp
      yield* pullRequests.refresh(RUN, url(1))
      assert.strictEqual(yield* readsOf(url(1)), 0)
    }).pipe(Effect.scoped)
  )

  describe('polling (success criterion 11)', () => {
    it.effect('reads an open pull request again on each poll while followed', () =>
      Effect.gen(function* () {
        const { pullRequests, readsOf } = yield* setUp
        yield* pullRequests.link(RUN, url(1))
        yield* settled(pullRequests)
        const follower = yield* following(pullRequests)
        yield* afterPolls(2)
        yield* Fiber.interrupt(follower)
        assert.strictEqual(yield* readsOf(url(1)), 1 + 2)
      }).pipe(Effect.scoped)
    )

    it.effect('does not poll before one interval has passed', () =>
      Effect.gen(function* () {
        const { pullRequests, readsOf } = yield* setUp
        yield* pullRequests.link(RUN, url(1))
        yield* settled(pullRequests)
        const follower = yield* following(pullRequests)
        yield* TestClock.adjust(Duration.subtract(POLL_INTERVAL, Duration.seconds(1)))
        yield* Fiber.interrupt(follower)
        assert.strictEqual(yield* readsOf(url(1)), 1)
      }).pipe(Effect.scoped)
    )

    it.effect('does not read a merged pull request on a poll', () =>
      Effect.gen(function* () {
        const { pullRequests, answer, readsOf } = yield* setUp
        yield* answer(url(1), 'merged')
        yield* pullRequests.link(RUN, url(1))
        yield* settled(pullRequests)
        const follower = yield* following(pullRequests)
        yield* afterPolls(3)
        yield* Fiber.interrupt(follower)
        assert.strictEqual(yield* readsOf(url(1)), 1)
      }).pipe(Effect.scoped)
    )

    it.effect('reads nothing once the last follower ends', () =>
      Effect.gen(function* () {
        const { pullRequests, readsOf } = yield* setUp
        yield* pullRequests.link(RUN, url(1))
        yield* settled(pullRequests)
        const follower = yield* following(pullRequests)
        yield* afterPolls(1)
        yield* Fiber.interrupt(follower)
        yield* afterPolls(3)
        assert.strictEqual(yield* readsOf(url(1)), 1 + 1)
      }).pipe(Effect.scoped)
    )

    it.effect('reads a failed pull request again, so a passing failure recovers', () =>
      Effect.gen(function* () {
        const { pullRequests, answer } = yield* setUp
        yield* answer(url(1), { fails: 'GitHub CLI timed out' })
        yield* pullRequests.link(RUN, url(1))
        yield* settled(pullRequests)
        yield* answer(url(1), 'merged')
        const follower = yield* following(pullRequests)
        yield* afterPolls(1)
        yield* Fiber.interrupt(follower)
        const [entry] = yield* current(pullRequests)
        assert.strictEqual(entry?.read._tag, 'Read')
      }).pipe(Effect.scoped)
    )

    it.effect('two followers of one run read an open pull request once per poll', () =>
      Effect.gen(function* () {
        const { pullRequests, readsOf } = yield* setUp
        yield* pullRequests.link(RUN, url(1))
        yield* settled(pullRequests)
        const card = yield* following(pullRequests)
        const panel = yield* following(pullRequests)
        yield* afterPolls(1)
        yield* Fiber.interrupt(card)
        yield* Fiber.interrupt(panel)
        assert.strictEqual(yield* readsOf(url(1)), 1 + 1)
      }).pipe(Effect.scoped)
    )
  })
})

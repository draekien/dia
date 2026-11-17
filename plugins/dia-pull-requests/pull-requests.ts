import {
  Clock,
  Duration,
  Effect,
  HashMap,
  Option,
  Schedule,
  Semaphore,
  Stream,
  SubscriptionRef,
  SynchronizedRef
} from 'effect'
import {
  type LinkedPullRequest,
  PullRequestRead,
  PullRequestReadFailed,
  PullRequestReading
} from './calls'
import type { GitHubCli } from './gh'
import type { PullRequestUrl } from './pull-request-url'
import type { LinkStore } from './store'

/** How often a followed run's due pull requests are read again. */
export const POLL_INTERVAL = Duration.seconds(60)

/** Every run's linked pull requests and what dia last learned about each. */
export interface PullRequests {
  /**
   * Stores the link of `url` to run `runId` and returns `true`, or `false` when it already
   * existed. For a new link it starts the first read in the background and does not wait for
   * it; until that read ends the pull request is `Reading`.
   */
  readonly link: (runId: string, url: PullRequestUrl) => Effect.Effect<boolean>
  /** Removes the link; the pull request on GitHub is not changed. */
  readonly unlink: (runId: string, url: PullRequestUrl) => Effect.Effect<void>
  /** Reads the pull request again and returns when the read ends. Does nothing for an unlinked URL. */
  readonly refresh: (runId: string, url: PullRequestUrl) => Effect.Effect<void>
  /**
   * Run `runId`'s pull requests now and after each change. While the stream is consumed, every
   * {@link POLL_INTERVAL} it reads each pull request whose state is `Reading`, `ReadFailed`, or
   * `Read` with `open` or `draft`. The reads stop when the stream ends.
   */
  readonly follow: (runId: string) => Stream.Stream<ReadonlyArray<LinkedPullRequest>>
}

interface RunState {
  readonly links: SubscriptionRef.SubscriptionRef<ReadonlyArray<LinkedPullRequest>>
  readonly gates: Map<PullRequestUrl, Semaphore.Semaphore>
}

type ShouldRead = (entry: LinkedPullRequest, now: number) => boolean

const READING = PullRequestReading.make({})
const RECENT = Duration.toMillis(POLL_INTERVAL) / 2
const POLL_CONCURRENCY = 4

const always: ShouldRead = () => true

const isDue: ShouldRead = (entry, now) => {
  if (entry.read._tag !== 'Read') return true
  const { state } = entry.read.details
  return (state === 'open' || state === 'draft') && now - entry.read.at >= RECENT
}

const reading = (url: PullRequestUrl): LinkedPullRequest => ({ url, read: READING })

/**
 * Builds {@link PullRequests} over `store` and `gh`. Background reads run in the calling scope
 * and stop when it closes.
 */
export const makePullRequests = (store: LinkStore, gh: GitHubCli) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const runs = yield* SynchronizedRef.make(HashMap.empty<string, RunState>())

    const gateOf = (state: RunState, url: PullRequestUrl) =>
      Effect.sync(() => {
        const existing = state.gates.get(url)
        if (existing !== undefined) return existing
        const gate = Semaphore.makeUnsafe(1)
        state.gates.set(url, gate)
        return gate
      })

    const readNow = (runId: string, state: RunState, url: PullRequestUrl) =>
      gh.view(url).pipe(
        Effect.matchEffect({
          onSuccess: (details) =>
            Effect.map(Clock.currentTimeMillis, (at) => PullRequestRead.make({ details, at })),
          onFailure: (error) =>
            Effect.as(
              Effect.logWarning('Could not read a linked pull request', {
                runId,
                url,
                message: error.message
              }),
              PullRequestReadFailed.make({ message: error.message })
            )
        }),
        Effect.flatMap((read) =>
          SubscriptionRef.update(state.links, (links) =>
            links.map((entry) => (entry.url === url ? { url, read } : entry))
          )
        ),
        Effect.tap(() => Effect.logDebug('Read a linked pull request', { runId, url }))
      )

    const read = (runId: string, state: RunState, url: PullRequestUrl, shouldRead: ShouldRead) =>
      Effect.flatMap(gateOf(state, url), (gate) =>
        gate.withPermit(
          Effect.gen(function* () {
            const entry = (yield* SubscriptionRef.get(state.links)).find((link) => link.url === url)
            const now = yield* Clock.currentTimeMillis
            if (entry === undefined || !shouldRead(entry, now)) return
            yield* readNow(runId, state, url)
          })
        )
      )

    const readInBackground = (runId: string, state: RunState, url: PullRequestUrl) =>
      Effect.asVoid(Effect.forkIn(read(runId, state, url, always), scope))

    const runState = (runId: string) =>
      SynchronizedRef.modifyEffect(runs, (states) =>
        Option.match(HashMap.get(states, runId), {
          onSome: (state) => Effect.succeed([state, states] as const),
          onNone: () =>
            Effect.gen(function* () {
              const urls = yield* store.list(runId)
              const state: RunState = {
                links: yield* SubscriptionRef.make<ReadonlyArray<LinkedPullRequest>>(
                  urls.map(reading)
                ),
                gates: new Map()
              }
              yield* Effect.forEach(urls, (url) => readInBackground(runId, state, url), {
                discard: true
              })
              yield* Effect.logDebug('Loaded the pull request links of a run', {
                runId,
                count: urls.length
              })
              return [state, HashMap.set(states, runId, state)] as const
            })
        })
      )

    const link = (runId: string, url: PullRequestUrl) =>
      Effect.gen(function* () {
        const state = yield* runState(runId)
        const added = yield* store.link(runId, url)
        if (!added) return false
        const appended = yield* SubscriptionRef.modify(state.links, (links) =>
          links.some((entry) => entry.url === url)
            ? [false, links]
            : [true, [...links, reading(url)]]
        )
        if (appended) yield* readInBackground(runId, state, url)
        yield* Effect.logDebug('Linked a pull request', { runId, url })
        return true
      })

    const unlink = (runId: string, url: PullRequestUrl) =>
      Effect.gen(function* () {
        const state = yield* runState(runId)
        yield* store.unlink(runId, url)
        yield* SubscriptionRef.update(state.links, (links) =>
          links.filter((entry) => entry.url !== url)
        )
        yield* Effect.logDebug('Unlinked a pull request', { runId, url })
      })

    const refresh = (runId: string, url: PullRequestUrl) =>
      Effect.flatMap(runState(runId), (state) => read(runId, state, url, always))

    const pollOnce = (runId: string, state: RunState) =>
      Effect.gen(function* () {
        const links = yield* SubscriptionRef.get(state.links)
        const now = yield* Clock.currentTimeMillis
        const due = links.filter((entry) => isDue(entry, now))
        yield* Effect.logDebug('Polling linked pull requests', { runId, due: due.length })
        yield* Effect.forEach(due, (entry) => read(runId, state, entry.url, isDue), {
          concurrency: POLL_CONCURRENCY,
          discard: true
        })
      })

    const polls = (runId: string, state: RunState) =>
      Stream.fromSchedule(Schedule.spaced(POLL_INTERVAL)).pipe(
        Stream.mapEffect(() => pollOnce(runId, state)),
        Stream.drain
      )

    const follow = (runId: string) =>
      Stream.unwrap(
        Effect.map(runState(runId), (state) =>
          Stream.merge(SubscriptionRef.changes(state.links), polls(runId, state)).pipe(
            Stream.ensuring(Effect.logDebug('Stopped following a run', { runId }))
          )
        )
      )

    return { link, unlink, refresh, follow } satisfies PullRequests
  })

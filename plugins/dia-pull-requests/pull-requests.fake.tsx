import { Option, Schema, Stream } from 'effect'
import { Atom } from 'effect/reactivity'
import { makePullRequestAtoms, type PullRequestAtoms } from './atoms'
import {
  type LinkedPullRequest,
  type PullRequestDetails,
  PullRequestRead,
  PullRequestReadFailed,
  PullRequestReading
} from './calls'
import { PullRequestUrl } from './pull-request-url'

/** A run id to pass as `runId` to the pull request components under test. */
export const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'

/** The canonical URL of pull request `number` in `draekien/dia`. */
export const prUrl = (number: number): PullRequestUrl =>
  Schema.decodeSync(PullRequestUrl)(`https://github.com/draekien/dia/pull/${number}`)

/** Open pull request `number` with no checks, activity or description, changed by `overrides`. */
export const details = (
  number: number,
  overrides: Partial<PullRequestDetails> = {}
): PullRequestDetails => ({
  number,
  title: `Pull request ${number}`,
  state: 'open',
  author: 'octocat',
  baseRef: 'main',
  headRef: `feat/${number}`,
  additions: 0,
  deletions: 0,
  body: '',
  checks: [],
  activity: [],
  ...overrides
})

/** Pull request `number`, linked and read as `overrides` describe. */
export const readPullRequest = (
  number: number,
  overrides: Partial<PullRequestDetails> = {}
): LinkedPullRequest => ({
  url: prUrl(number),
  read: PullRequestRead.make({ details: details(number, overrides), at: 0 })
})

/** Pull request `number`, linked and still being read. */
export const readingPullRequest = (number: number): LinkedPullRequest => ({
  url: prUrl(number),
  read: PullRequestReading.make({})
})

/** Pull request `number`, linked, whose last read failed with `message`. */
export const failedPullRequest = (number: number, message: string): LinkedPullRequest => ({
  url: prUrl(number),
  read: PullRequestReadFailed.make({ message })
})

/**
 * Pull request atoms that report `linked` for every run id. `unlink` and `refresh` default to
 * resolving at once; pass spies to observe them.
 */
export const fakeAtoms = (
  linked: ReadonlyArray<LinkedPullRequest>,
  actions: Partial<Pick<PullRequestAtoms, 'unlink' | 'refresh'>> = {}
): PullRequestAtoms => ({
  ...makePullRequestAtoms({ name: 'dia-pull-requests' }),
  runPullRequests: Atom.family((_runId: string) =>
    Atom.make(Stream.make(Option.some(linked)))
  ) as unknown as PullRequestAtoms['runPullRequests'],
  unlink: actions.unlink ?? (() => Promise.resolve()),
  refresh: actions.refresh ?? (() => Promise.resolve())
})

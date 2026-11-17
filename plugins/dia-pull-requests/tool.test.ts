import type { ToolScope } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Ref, Schema } from 'effect'
import { PullRequestUrl } from './pull-request-url'
import type { PullRequests } from './pull-requests'
import { linkPullRequestTool } from './tool'

const RUN_SCOPE: ToolScope = { runId: 'run-1', labels: [], context: undefined }
const OUTSIDE_SCOPE: ToolScope = { labels: [], context: undefined }

const recordingPullRequests = Effect.gen(function* () {
  const linked = yield* Ref.make<ReadonlyArray<readonly [string, PullRequestUrl]>>([])
  const pullRequests: PullRequests = {
    link: (runId, url) =>
      Ref.modify(linked, (links) => {
        const exists = links.some(([run, link]) => run === runId && link === url)
        return [!exists, exists ? links : [...links, [runId, url] as const]]
      }),
    unlink: () => Effect.void,
    refresh: () => Effect.void,
    follow: () => {
      throw new Error('follow is not used by the tool')
    }
  }
  return { tool: linkPullRequestTool(pullRequests), linked: Ref.get(linked) }
})

describe('link_pull_request', () => {
  it.effect('links the canonical URL to the calling run (success criterion 1)', () =>
    Effect.gen(function* () {
      const { tool, linked } = yield* recordingPullRequests
      const result = yield* tool.run(
        { url: 'https://github.com/draekien/dia/pull/295/files' },
        RUN_SCOPE
      )
      assert.deepStrictEqual(result, { text: 'Linked draekien/dia#295.', isError: false })
      assert.deepStrictEqual(yield* linked, [
        ['run-1', Schema.decodeSync(PullRequestUrl)('https://github.com/draekien/dia/pull/295')]
      ])
    })
  )

  it.effect('says a repeated link is already linked', () =>
    Effect.gen(function* () {
      const { tool } = yield* recordingPullRequests
      yield* tool.run({ url: 'https://github.com/draekien/dia/pull/295' }, RUN_SCOPE)
      const result = yield* tool.run({ url: 'https://github.com/draekien/dia/pull/295' }, RUN_SCOPE)
      assert.deepStrictEqual(result, {
        text: 'draekien/dia#295 is already linked.',
        isError: false
      })
    })
  )

  it.effect(
    'refuses a URL that is not a GitHub pull request and links nothing (success criterion 2)',
    () =>
      Effect.gen(function* () {
        const { tool, linked } = yield* recordingPullRequests
        const result = yield* tool.run(
          { url: 'https://gitlab.com/x/y/-/merge_requests/1' },
          RUN_SCOPE
        )
        assert.deepStrictEqual(result, {
          text: 'Not a GitHub pull request URL: https://gitlab.com/x/y/-/merge_requests/1. Pass https://github.com/<owner>/<repo>/pull/<number>.',
          isError: true
        })
        assert.deepStrictEqual(yield* linked, [])
      })
  )

  it.effect('refuses a call from outside a dia run', () =>
    Effect.gen(function* () {
      const { tool, linked } = yield* recordingPullRequests
      const result = yield* tool.run(
        { url: 'https://github.com/draekien/dia/pull/295' },
        OUTSIDE_SCOPE
      )
      assert.isTrue(result.isError)
      assert.deepStrictEqual(yield* linked, [])
    })
  )
})

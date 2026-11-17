import { assert, describe, it } from '@effect/vitest'
import { Result, Schema } from 'effect'
import { PullRequestUrl, pullRequestLabel, pullRequestRef } from './pull-request-url'

const decode = Schema.decodeUnknownResult(PullRequestUrl)

const CANONICAL = 'https://github.com/draekien/dia/pull/295'

const decoded = (input: string) => {
  const result = decode(input)
  assert.isTrue(Result.isSuccess(result), `expected ${input} to decode`)
  return Result.getOrThrow(result)
}

describe('PullRequestUrl', () => {
  it.each([
    ['the canonical form', CANONICAL],
    ['a trailing path', `${CANONICAL}/files`],
    ['a trailing slash', `${CANONICAL}/`],
    ['a fragment', `${CANONICAL}#issuecomment-1`],
    ['a query', `${CANONICAL}?w=1`],
    ['http', 'http://github.com/draekien/dia/pull/295'],
    ['www', 'https://www.github.com/draekien/dia/pull/295']
  ])('decodes %s to the canonical URL', (_, input) => {
    assert.strictEqual(decoded(input), CANONICAL)
  })

  it.each([
    ['a GitLab merge request', 'https://gitlab.com/x/y/-/merge_requests/1'],
    ['an issue', 'https://github.com/draekien/dia/issues/295'],
    ['a repository', 'https://github.com/draekien/dia'],
    ['pull request zero', 'https://github.com/draekien/dia/pull/0'],
    ['a non-numeric number', 'https://github.com/draekien/dia/pull/abc'],
    ['a GitHub Enterprise host', 'https://github.example.com/draekien/dia/pull/295'],
    ['a look-alike host', 'https://github.com.evil.example/draekien/dia/pull/295'],
    ['a non-web scheme', 'javascript://github.com/draekien/dia/pull/295'],
    ['plain text', 'draekien/dia#295'],
    ['an empty string', '']
  ])('rejects %s', (_, input) => {
    assert.isTrue(Result.isFailure(decode(input)))
  })

  it('encodes to the canonical string', () => {
    assert.strictEqual(Schema.encodeSync(PullRequestUrl)(decoded(`${CANONICAL}/files`)), CANONICAL)
  })
})

describe('pullRequestRef', () => {
  it('names the owner, repository and number', () => {
    assert.deepStrictEqual(pullRequestRef(decoded(CANONICAL)), {
      owner: 'draekien',
      repo: 'dia',
      number: 295
    })
  })
})

describe('pullRequestLabel', () => {
  it('reads owner/repo#number', () => {
    assert.strictEqual(pullRequestLabel(decoded(CANONICAL)), 'draekien/dia#295')
  })
})

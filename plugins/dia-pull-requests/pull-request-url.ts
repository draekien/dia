import { Effect, Schema, SchemaIssue, SchemaTransformation } from 'effect'

const PULL_REQUEST_PATH = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)(?:\/.*)?$/
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
const WEB_PROTOCOLS = new Set(['http:', 'https:'])

const canonicalUrl = (input: string): string | undefined => {
  if (!URL.canParse(input)) return undefined
  const url = new URL(input)
  if (!WEB_PROTOCOLS.has(url.protocol) || !GITHUB_HOSTS.has(url.hostname)) return undefined
  const match = PULL_REQUEST_PATH.exec(url.pathname)
  if (match === null) return undefined
  const [, owner, repo, number] = match
  return `https://github.com/${owner}/${repo}/pull/${number}`
}

const CanonicalPullRequestUrl = Schema.String.pipe(Schema.brand('PullRequestUrl'))

/**
 * A github.com pull request URL, decoded from a string into the canonical form
 * `https://github.com/<owner>/<repo>/pull/<n>`. Decoding accepts `http:`, `www.github.com`, and a
 * trailing path, query or fragment (`/files`, `#issuecomment-1`); any other string fails.
 * Encoding returns the canonical string.
 */
export const PullRequestUrl = Schema.String.pipe(
  Schema.decodeTo(
    CanonicalPullRequestUrl,
    SchemaTransformation.transformEffect({
      decode: (input: string, options) => {
        const canonical = canonicalUrl(input)
        return canonical === undefined
          ? Effect.fail(
              new SchemaIssue.InvalidValue(
                { expected: 'a GitHub pull request URL' },
                input,
                options
              )
            )
          : Effect.succeed(CanonicalPullRequestUrl.make(canonical))
      },
      encode: (url: string) => Effect.succeed(url)
    })
  )
)
/** A canonical github.com pull request URL; see {@link PullRequestUrl}. */
export type PullRequestUrl = typeof PullRequestUrl.Type

/** The owner, repository and number that `url` names. */
export const pullRequestRef = (
  url: PullRequestUrl
): { readonly owner: string; readonly repo: string; readonly number: number } => {
  const [owner = '', repo = '', , number = '0'] = new URL(url).pathname.slice(1).split('/')
  return { owner, repo, number: Number(number) }
}

/** `owner/repo#n`, the label the tool result and the card use for `url`. */
export const pullRequestLabel = (url: PullRequestUrl): string => {
  const { owner, repo, number } = pullRequestRef(url)
  return `${owner}/${repo}#${number}`
}

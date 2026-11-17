import type { PluginMigrations } from '@dia/plugin'
import { Clock, Effect, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { PullRequestUrl } from './pull-request-url'

/** The `dia-pull-requests` plugin's database migrations; pass them to `ctx.database`. */
export const pullRequestMigrations: PluginMigrations = {
  '1_create_links': Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE links (
      run_id    TEXT    NOT NULL,
      url       TEXT    NOT NULL,
      linked_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, url)
    )`)
  })
}

/** The pull request links of every run, in the plugin database. */
export interface LinkStore {
  /** Adds the link of `url` to run `runId`; `false` when it already existed. */
  readonly link: (runId: string, url: PullRequestUrl) => Effect.Effect<boolean>
  /** Removes the link; succeeds when there was none. */
  readonly unlink: (runId: string, url: PullRequestUrl) => Effect.Effect<void>
  /** Run `runId`'s links, oldest first. */
  readonly list: (runId: string) => Effect.Effect<ReadonlyArray<PullRequestUrl>>
}

const UrlRows = Schema.Array(Schema.Struct({ url: Schema.String }))
const decodeUrlRows = Schema.decodeUnknownEffect(UrlRows)
const decodeUrl = Schema.decodeUnknownResult(PullRequestUrl)
const encodeUrl = Schema.encodeSync(PullRequestUrl)

/** A {@link LinkStore} over the `SqlClient` that `ctx.database(pullRequestMigrations)` returned. */
export const makeLinkStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const link = (runId: string, url: PullRequestUrl) =>
    Effect.gen(function* () {
      const linkedAt = yield* Clock.currentTimeMillis
      const inserted = yield* sql`INSERT INTO links (run_id, url, linked_at)
        VALUES (${runId}, ${encodeUrl(url)}, ${linkedAt})
        ON CONFLICT (run_id, url) DO NOTHING
        RETURNING url`
      yield* Effect.logDebug('Stored a pull request link', {
        runId,
        url,
        added: inserted.length > 0
      })
      return inserted.length > 0
    }).pipe(Effect.orDie)

  const unlink = (runId: string, url: PullRequestUrl) =>
    sql`DELETE FROM links WHERE run_id = ${runId} AND url = ${encodeUrl(url)}`.pipe(
      Effect.tap(() => Effect.logDebug('Removed a pull request link', { runId, url })),
      Effect.asVoid,
      Effect.orDie
    )

  const list = (runId: string) =>
    Effect.gen(function* () {
      const rows = yield* decodeUrlRows(
        yield* sql`SELECT url FROM links WHERE run_id = ${runId} ORDER BY linked_at, rowid`
      )
      const urls: Array<PullRequestUrl> = []
      for (const row of rows) {
        const url = decodeUrl(row.url)
        if (Result.isSuccess(url)) urls.push(url.success)
        else yield* Effect.logWarning('Skipped a stored link that is not a pull request URL', row)
      }
      return urls
    }).pipe(Effect.orDie)

  return { link, unlink, list } satisfies LinkStore
})

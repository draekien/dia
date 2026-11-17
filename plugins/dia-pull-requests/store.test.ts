import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Path, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { openDatabase } from '../../src/host/services/database'
import { PullRequestUrl } from './pull-request-url'
import { type LinkStore, makeLinkStore, pullRequestMigrations } from './store'

const url = (number: number) =>
  Schema.decodeSync(PullRequestUrl)(`https://github.com/draekien/dia/pull/${number}`)

const RUN = 'run-1'
const OTHER_RUN = 'run-2'

const withStore = <A, E>(filename: string, use: (store: LinkStore) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const sql = yield* openDatabase(filename, pullRequestMigrations)
    const store = yield* makeLinkStore.pipe(Effect.provideService(SqlClient.SqlClient, sql))
    return yield* use(store)
  }).pipe(Effect.scoped)

const inMemory = <A, E>(use: (store: LinkStore) => Effect.Effect<A, E>) =>
  withStore(':memory:', use)

describe('LinkStore', () => {
  it.effect('reports a new link as added and a repeated link as not added', () =>
    inMemory((store) =>
      Effect.gen(function* () {
        const first = yield* store.link(RUN, url(1))
        const second = yield* store.link(RUN, url(1))
        assert.deepStrictEqual([first, second], [true, false])
        assert.deepStrictEqual(yield* store.list(RUN), [url(1)])
      })
    )
  )

  it.effect('lists a run’s links oldest first, apart from other runs', () =>
    inMemory((store) =>
      Effect.gen(function* () {
        yield* store.link(RUN, url(2))
        yield* TestClock.adjust('1 second')
        yield* store.link(OTHER_RUN, url(9))
        yield* TestClock.adjust('1 second')
        yield* store.link(RUN, url(1))
        assert.deepStrictEqual(yield* store.list(RUN), [url(2), url(1)])
      })
    )
  )

  it.effect('lists nothing for a run with no links', () =>
    inMemory((store) => Effect.map(store.list(RUN), (links) => assert.deepStrictEqual(links, [])))
  )

  it.effect('removes only the unlinked pull request, and unlinking twice succeeds', () =>
    inMemory((store) =>
      Effect.gen(function* () {
        yield* store.link(RUN, url(1))
        yield* store.link(RUN, url(2))
        yield* store.unlink(RUN, url(1))
        yield* store.unlink(RUN, url(1))
        assert.deepStrictEqual(yield* store.list(RUN), [url(2)])
      })
    )
  )

  it.effect('skips a stored row that is not a pull request URL', () =>
    Effect.gen(function* () {
      const sql = yield* openDatabase(':memory:', pullRequestMigrations)
      yield* sql`INSERT INTO links (run_id, url, linked_at) VALUES (${RUN}, 'not a url', 0)`
      const store = yield* makeLinkStore.pipe(Effect.provideService(SqlClient.SqlClient, sql))
      yield* store.link(RUN, url(1))
      assert.deepStrictEqual(yield* store.list(RUN), [url(1)])
    }).pipe(Effect.scoped)
  )

  it.effect('keeps links across a restart on a file-backed database (success criterion 4)', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const filename = path.join(yield* fs.makeTempDirectoryScoped(), 'data.db')
      yield* withStore(filename, (store) => store.link(RUN, url(1)))
      const listed = yield* withStore(filename, (store) => store.list(RUN))
      assert.deepStrictEqual(listed, [url(1)])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

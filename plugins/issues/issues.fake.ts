import { ProjectId } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Effect, Exit, Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { AssigneeRef, ProviderId } from './domain'
import { makeIssues } from './make-issues'
import type { Issues } from './service'
import { issuesMigrations } from './store'

/** The project the fake workspace registers. */
export const PROJECT = ProjectId.make('00000000-0000-4000-8000-400000000001')

/** A project the fake workspace does not register. */
export const UNREGISTERED = ProjectId.make('00000000-0000-4000-8000-400000000002')

/** The provider id the fixtures register: `org`. */
export const ORG = ProviderId.make('org')

/** The assignee reference of `id` under the `org` provider. */
export const orgRef = (id: string) => AssigneeRef.make({ provider: ORG, id })

/**
 * A real `Issues` on an in-memory database that lists only {@link PROJECT}, with the `sql` client
 * of that database. The database closes with the calling scope.
 */
export const openIssues = Effect.gen(function* () {
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  const sql = yield* openDatabase(':memory:', issuesMigrations).pipe(Scope.provide(scope))
  const issues = yield* makeIssues((projectId) => Effect.succeed(projectId === PROJECT)).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provide(NodeCrypto.layer)
  )
  return { issues, sql }
})

/**
 * Registers provider `id` (label `Org` for `org`) listing `assigneeIds` until `scope` closes, and
 * returns its `ProviderIssues`.
 */
export const registerFixed = (
  issues: Issues,
  assigneeIds: ReadonlyArray<string>,
  id: ProviderId = ORG
) =>
  issues.registerProvider({
    id,
    label: id === ORG ? 'Org' : id,
    assignees: Stream.make(
      assigneeIds.map((assignee) => ({ id: assignee, name: assignee, detail: '' }))
    )
  })

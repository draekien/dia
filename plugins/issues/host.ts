import type { HostPluginContext, PluginSetup, ProjectId } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Deferred, Effect, Option, Ref, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  AssignIssue,
  CreateIssue,
  CreateObjective,
  FinishIssue,
  ReadIssues,
  TriageIssues,
  WatchIssues
} from './calls'
import { makeIssues } from './make-issues'
import { type Issues, IssuesKey } from './service'
import { issuesMigrations } from './store'

type Workspace = Stream.Success<HostPluginContext['workspace']>

const readView = (issues: Issues) =>
  Effect.map(Effect.all([issues.snapshot, issues.providers]), ([snapshot, providers]) => ({
    ...snapshot,
    providers
  }))

const watchView = (issues: Issues) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const changes = yield* issues.watchChanges
      yield* Effect.logDebug('Watching issues')
      return Stream.concat(
        Stream.make(undefined),
        changes.pipe(Stream.buffer({ capacity: 1, strategy: 'sliding' }))
      ).pipe(Stream.mapEffect(() => readView(issues)))
    })
  )

const projectRegistered = (workspace: Ref.Ref<Option.Option<Workspace>>, projectId: ProjectId) =>
  Effect.map(Ref.get(workspace), (current) =>
    Option.match(current, {
      onNone: () => false,
      onSome: (value) => value.projects.some(({ project }) => project.projectId === projectId)
    })
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(issuesMigrations)
    const workspace = yield* Ref.make(Option.none<Workspace>())
    const first = yield* Deferred.make<void>()
    yield* ctx.workspace.pipe(
      Stream.runForEach((current) =>
        Ref.set(workspace, Option.some(current)).pipe(
          Effect.andThen(Deferred.succeed(first, undefined))
        )
      ),
      Effect.forkScoped
    )
    yield* Deferred.await(first)
    const issues = yield* makeIssues((projectId) => projectRegistered(workspace, projectId)).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    yield* ctx.provide(IssuesKey, issues)
    yield* Effect.all(
      [
        ctx.serve(ReadIssues, () => readView(issues)),
        ctx.serve(WatchIssues, () => watchView(issues)),
        ctx.serve(CreateObjective, ({ objective }) => issues.createObjective(objective, [])),
        ctx.serve(CreateIssue, ({ issue }) => issues.createIssue(issue)),
        ctx.serve(AssignIssue, ({ issueId, assignee }) => issues.assignIssue(issueId, assignee)),
        ctx.serve(TriageIssues, ({ issueIds, decision }) =>
          issues.triageIssues(issueIds, decision)
        ),
        ctx.serve(FinishIssue, ({ issueId }) => issues.finishIssue(issueId))
      ],
      { discard: true }
    )
    yield* Effect.logInfo('Issues service provided', {
      plugin: ctx.name,
      objectives: (yield* issues.snapshot).objectives.length
    })
  })

export default setup

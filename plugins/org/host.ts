import {
  type AgentBackend,
  AgentBackendKey,
  type HostPluginContext,
  type PluginSetup,
  type ProjectId
} from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Deferred, Effect, Option, Ref, type Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { bypassAvailable } from './bypass'
import {
  AnswerPermission,
  AssignTask,
  CopyJobTitle,
  CreateObjective,
  CreateTask,
  DeleteJobTitle,
  Dismiss,
  EditJobTitle,
  FinishTask,
  Hire,
  ReadOrg,
  ReadWork,
  RenameHire,
  SetBypassOverride,
  SetJobTitleEnabled,
  SetOverallCap,
  SetReportsTo
} from './calls'
import { type Dispatcher, makeDispatcher } from './dispatcher'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { type Org, OrgService } from './service'
import { makeWork, type Work } from './work'

type Workspace = Stream.Success<HostPluginContext['workspace']>

const holdAgentBackend = (
  ctx: HostPluginContext,
  backend: Ref.Ref<Option.Option<AgentBackend>>,
  dispatcher: Dispatcher
) =>
  ctx
    .whenProvided([AgentBackendKey], ({ agentBackend }) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Ref.set(backend, Option.some(agentBackend)).pipe(
            Effect.tap(() => Effect.logDebug('Org holds the agent backend'))
          ),
          () => Ref.set(backend, Option.none())
        )
        yield* dispatcher.lendBackend(agentBackend)
      })
    )
    .pipe(Effect.orDie)

const projectDirectories = (workspace: Workspace) =>
  workspace.projects.map(({ project }) => `${project.projectId}=${project.directory}`).join('\n')

const followWorkspace = (
  ctx: HostPluginContext,
  workspace: Ref.Ref<Option.Option<Workspace>>,
  dispatcher: Dispatcher
) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>()
    yield* ctx.workspace.pipe(
      Stream.changesWith(
        (previous, current) => projectDirectories(previous) === projectDirectories(current)
      ),
      Stream.runForEach((current) =>
        Ref.set(workspace, Option.some(current)).pipe(
          Effect.andThen(Deferred.succeed(first, undefined)),
          Effect.andThen(dispatcher.signal)
        )
      ),
      Effect.forkScoped
    )
    yield* Deferred.await(first)
  })

const directoryOf = (workspace: Ref.Ref<Option.Option<Workspace>>, projectId: ProjectId) =>
  Effect.map(Ref.get(workspace), (current) =>
    Option.flatMap(current, (value) =>
      Option.fromNullishOr(
        value.projects.find((entry) => entry.project.projectId === projectId)?.project.directory
      )
    )
  )

const serveOrgCalls = (
  ctx: HostPluginContext,
  org: Org,
  backend: Ref.Ref<Option.Option<AgentBackend>>,
  dispatcher: Dispatcher
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.all(
    [
      ctx.serve(ReadOrg, () =>
        Effect.all({
          jobTitles: org.jobTitles,
          hiredAgents: org.hiredAgents,
          settings: org.settings,
          bypassAvailable: bypassAvailable(backend)
        })
      ),
      ctx.serve(SetJobTitleEnabled, ({ jobTitleId, enabled }) =>
        org.setJobTitleEnabled(jobTitleId, enabled)
      ),
      ctx.serve(CopyJobTitle, ({ jobTitleId, name }) => org.copyJobTitle(jobTitleId, name)),
      ctx.serve(EditJobTitle, ({ jobTitleId, edit }) => org.editJobTitle(jobTitleId, edit)),
      ctx.serve(DeleteJobTitle, ({ jobTitleId }) => org.deleteJobTitle(jobTitleId)),
      ctx.serve(Hire, ({ jobTitleId, name, reportsTo }) => org.hire(jobTitleId, name, reportsTo)),
      ctx.serve(Dismiss, ({ hireId }) => org.dismiss(hireId)),
      ctx.serve(RenameHire, ({ hireId, name }) => org.renameHire(hireId, name)),
      ctx.serve(SetBypassOverride, ({ hireId, override }) =>
        org.setBypassOverride(hireId, override)
      ),
      ctx.serve(SetReportsTo, ({ hireId, reportsTo }) => org.setReportsTo(hireId, reportsTo)),
      ctx.serve(SetOverallCap, ({ cap }) =>
        org.setOverallCap(cap).pipe(Effect.tap(() => dispatcher.signal))
      )
    ],
    { discard: true }
  )

const serveWorkCalls = (
  ctx: HostPluginContext,
  work: Work,
  dispatcher: Dispatcher
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.all(
    [
      ctx.serve(ReadWork, () =>
        Effect.map(Effect.all([work.snapshot, dispatcher.live]), ([snapshot, live]) => ({
          ...snapshot,
          ...live
        }))
      ),
      ctx.serve(CreateObjective, ({ objective }) => work.createObjective(objective)),
      ctx.serve(CreateTask, ({ task }) =>
        work.createTask(task).pipe(Effect.tap(() => dispatcher.signal))
      ),
      ctx.serve(AssignTask, ({ taskId, hireId }) =>
        work
          .assignTask(taskId, hireId)
          .pipe(
            Effect.tap((task) =>
              task.state === 'waiting' ? dispatcher.release(taskId) : Effect.void
            )
          )
      ),
      ctx.serve(FinishTask, ({ taskId }) =>
        work.finishTask(taskId).pipe(Effect.tap(() => dispatcher.release(taskId)))
      ),
      ctx.serve(AnswerPermission, ({ taskId, requestId, response }) =>
        dispatcher.answerPermission(taskId, requestId, response)
      )
    ],
    { discard: true }
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(orgMigrations)
    const workspace = yield* Ref.make(Option.none<Workspace>())
    const { work, runs, openTasksOf } = yield* makeWork((projectId) =>
      Effect.map(directoryOf(workspace, projectId), Option.isSome)
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provide(NodeCrypto.layer))
    const org = yield* makeOrg(openTasksOf).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    yield* ctx.provide(OrgService, org)
    const dispatcher = yield* makeDispatcher({
      runs,
      org,
      projectDirectory: (objective) => directoryOf(workspace, objective.projectId)
    })
    yield* followWorkspace(ctx, workspace, dispatcher)
    const backend = yield* Ref.make(Option.none<AgentBackend>())
    yield* holdAgentBackend(ctx, backend, dispatcher)
    yield* serveOrgCalls(ctx, org, backend, dispatcher)
    yield* serveWorkCalls(ctx, work, dispatcher)
    const jobTitles = yield* org.jobTitles
    const hires = yield* org.hiredAgents
    yield* Effect.logInfo('Org service provided', {
      plugin: ctx.name,
      jobTitles: jobTitles.length,
      hiredAgents: hires.length
    })
  })

export default setup

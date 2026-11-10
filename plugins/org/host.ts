import {
  type AgentBackend,
  AgentBackendKey,
  type GitOps,
  type HostPluginContext,
  type PluginSetup,
  type ProjectId,
  WorktreesKey
} from '@dia/plugin'
import {
  type AgentDefinitionRegistry,
  AgentDefinitionRegistryKey
} from '@dia-plugin/agent-definitions/registry'
import { ObjectiveId } from '@dia-plugin/issues/domain'
import { type Issues, IssuesKey } from '@dia-plugin/issues/service'
import { McpServerRegistryKey } from '@dia-plugin/mcp/registry'
import { SkillSourceRegistryKey } from '@dia-plugin/skills/registry'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef
} from 'effect'
import { SqlClient } from 'effect/sql'
import { orgAssignees } from './assignees'
import { makeAssistant } from './assistant'
import { BUILT_IN_DEFINITIONS } from './built-in-job-titles'
import { bypassAvailable } from './bypass'
import {
  AnswerPermission,
  CopyJobTitle,
  DeleteJobTitle,
  Dismiss,
  EditJobTitle,
  Hire,
  ReadOrg,
  RenameHire,
  SetBypassOverride,
  SetJobTitleEnabled,
  SetOverallCap,
  SetProjectWorktrees,
  SetReportsTo,
  WatchOrgLive
} from './calls'
import { type Dispatcher, makeDispatcher } from './dispatcher'
import {
  agentName,
  jobTitleName,
  type MissingReference,
  ORG_PROVIDER,
  sameMissingReferences
} from './domain'
import { handOverJobTitles, handOverWork, handoverPending, workHandoverPending } from './handover'
import { makeIssueWorkspace } from './issue-workspace'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { makeRoutingTools } from './routing-tools'
import { type Org, OrgService } from './service'
import { makeSessionTools, type SessionTools } from './session-tools'

type Workspace = Stream.Success<HostPluginContext['workspace']>

type AssistantMissing = SubscriptionRef.SubscriptionRef<ReadonlyArray<MissingReference>>

const watchOrgLive = (assistantMissing: AssistantMissing) =>
  SubscriptionRef.changes(assistantMissing).pipe(
    Stream.changesWith(sameMissingReferences),
    Stream.map((missing) => ({ assistantMissing: missing }))
  )

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

const holdGitOps = (
  ctx: HostPluginContext,
  gitOps: Ref.Ref<Option.Option<GitOps>>,
  dispatcher: Dispatcher
) =>
  ctx
    .whenProvided([WorktreesKey], ({ worktrees }) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Ref.set(gitOps, Option.some(worktrees)).pipe(
            Effect.tap(() => Effect.logDebug('Org holds the worktrees plugin'))
          ),
          () => Ref.set(gitOps, Option.none())
        )
        yield* dispatcher.signal
      })
    )
    .pipe(Effect.orDie)

const routingHires = (org: Org) =>
  Effect.map(Effect.all([org.hiredAgents, org.jobTitles]), ([hires, jobTitles]) =>
    hires.map((hire) => ({
      id: hire.id,
      name: agentName(hire, jobTitles),
      jobTitle: jobTitleName(hire, jobTitles) ?? 'agent'
    }))
  )

const routingProjects = (workspace: Ref.Ref<Option.Option<Workspace>>) =>
  Effect.map(Ref.get(workspace), (current) =>
    Option.match(current, {
      onNone: () => [],
      onSome: (value) =>
        value.projects.map(({ project }) => ({
          id: project.projectId,
          name: project.displayName
        }))
    })
  )

const runAssistant = (
  ctx: HostPluginContext,
  deps: {
    readonly sql: SqlClient.SqlClient
    readonly org: Org
    readonly work: Issues
    readonly workspace: Ref.Ref<Option.Option<Workspace>>
    readonly dispatcher: Dispatcher
    readonly sessionTools: SessionTools
    readonly assistantMissing: AssistantMissing
  }
) =>
  ctx
    .whenProvided([AgentBackendKey], ({ agentBackend }) =>
      Effect.gen(function* () {
        const directory = (yield* Path.Path).join(ctx.dataDir, 'assistant')
        yield* (yield* FileSystem.FileSystem).makeDirectory(directory, { recursive: true })
        const crypto = yield* Crypto.Crypto
        yield* makeAssistant({
          org: deps.org,
          work: deps.work,
          backend: agentBackend,
          tools: (claim) =>
            makeRoutingTools({
              work: deps.work,
              projects: routingProjects(deps.workspace),
              hires: routingHires(deps.org),
              newObjectiveId: crypto
                .randomUUIDv4()
                .pipe(Effect.orDie, Effect.map(ObjectiveId.make)),
              claim,
              dispatcher: deps.dispatcher
            }),
          attach: ctx.sessions.attach,
          directory,
          sessionTools: deps.sessionTools,
          missing: deps.assistantMissing
        }).pipe(Effect.provideService(SqlClient.SqlClient, deps.sql))
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)))
    )
    .pipe(Effect.orDie)

const runIssues = (
  ctx: HostPluginContext,
  deps: Omit<Parameters<typeof runAssistant>[1], 'work'>
) =>
  Effect.gen(function* () {
    if (yield* workHandoverPending.pipe(Effect.provideService(SqlClient.SqlClient, deps.sql))) {
      yield* Effect.logInfo('Org objectives and issues wait for issues to hand over')
    }
    yield* ctx.whenProvided([IssuesKey], ({ issues }) =>
      Effect.gen(function* () {
        yield* handOverWork(issues).pipe(Effect.provideService(SqlClient.SqlClient, deps.sql))
        const runs = yield* issues.registerProvider({
          id: ORG_PROVIDER,
          label: 'Org',
          assignees: orgAssignees(deps.org)
        })
        yield* deps.org.holdIssues(runs)
        yield* deps.dispatcher.lendIssues(issues, runs)
        yield* runAssistant(ctx, { ...deps, work: issues })
        yield* Effect.logInfo('Org runs its hired agents through issues')
      })
    )
  }).pipe(Effect.orDie)

const registerBuiltIns = (ctx: HostPluginContext, registry: AgentDefinitionRegistry) =>
  Effect.forEach(
    BUILT_IN_DEFINITIONS,
    (definition) =>
      registry.register(definition, ctx.name).pipe(
        Effect.catchTag('AgentDefinitionIdTaken', () =>
          Effect.logWarning('Another plugin holds a built-in job title id', {
            jobTitleId: definition.id
          })
        ),
        Effect.catchTag('AgentDefinitionNameTaken', () =>
          Effect.logWarning('Another definition holds a built-in job title name', {
            jobTitleId: definition.id,
            name: definition.name
          })
        )
      ),
    { discard: true }
  )

const holdRegistries = (
  ctx: HostPluginContext,
  org: Org,
  sessionTools: SessionTools,
  sql: SqlClient.SqlClient
) =>
  Effect.gen(function* () {
    yield* ctx.whenProvided([AgentDefinitionRegistryKey], ({ agentDefinitionRegistry }) =>
      Effect.gen(function* () {
        yield* org.holdDefinitions(agentDefinitionRegistry)
        yield* registerBuiltIns(ctx, agentDefinitionRegistry)
      })
    )
    yield* ctx.whenProvided([McpServerRegistryKey], ({ mcpServerRegistry }) =>
      sessionTools.holdMcp(mcpServerRegistry)
    )
    yield* ctx.whenProvided([SkillSourceRegistryKey], ({ skillSourceRegistry }) =>
      sessionTools.holdSkills(skillSourceRegistry)
    )
    if (yield* handoverPending.pipe(Effect.provideService(SqlClient.SqlClient, sql))) {
      yield* Effect.logInfo('Org job titles wait for agent-definitions and mcp to hand over')
    }
    yield* ctx.whenProvided(
      [AgentDefinitionRegistryKey, McpServerRegistryKey],
      ({ agentDefinitionRegistry, mcpServerRegistry }) =>
        handOverJobTitles(agentDefinitionRegistry, mcpServerRegistry).pipe(
          Effect.provideService(SqlClient.SqlClient, sql)
        )
    )
  }).pipe(Effect.orDie)

const projectDirectories = (workspace: Workspace) =>
  workspace.projects
    .map(({ project }) => `${project.projectId}=${project.directory}=${project.isGitRepo}`)
    .join('\n')

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

const projectOf = (workspace: Ref.Ref<Option.Option<Workspace>>, projectId: ProjectId) =>
  Effect.map(Ref.get(workspace), (current) =>
    Option.flatMap(current, (value) =>
      Option.fromNullishOr(
        value.projects.find((entry) => entry.project.projectId === projectId)?.project
      )
    )
  )

const serveOrgCalls = (
  ctx: HostPluginContext,
  org: Org,
  backend: Ref.Ref<Option.Option<AgentBackend>>,
  dispatcher: Dispatcher,
  worktrees: Pick<
    Effect.Success<ReturnType<typeof makeIssueWorkspace>>,
    'worktreeProjects' | 'setWorktreeProjects'
  >
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.all(
    [
      ctx.serve(ReadOrg, () =>
        Effect.all({
          jobTitles: org.jobTitles,
          hiredAgents: org.hiredAgents,
          settings: org.settings,
          bypassAvailable: bypassAvailable(backend),
          worktreeProjects: worktrees.worktreeProjects
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
      ),
      ctx.serve(SetProjectWorktrees, ({ projectId, enabled }) =>
        worktrees
          .setWorktreeProjects(projectId, enabled)
          .pipe(Effect.andThen(dispatcher.signal), Effect.andThen(worktrees.worktreeProjects))
      )
    ],
    { discard: true }
  )

const serveLiveCalls = (
  ctx: HostPluginContext,
  dispatcher: Dispatcher,
  assistantMissing: AssistantMissing
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.all(
    [
      ctx.serve(WatchOrgLive, () => watchOrgLive(assistantMissing)),
      ctx.serve(AnswerPermission, ({ issueId, requestId, response }) =>
        dispatcher.answerPermission(issueId, requestId, response)
      )
    ],
    { discard: true }
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(orgMigrations)
    const workspace = yield* Ref.make(Option.none<Workspace>())
    const org = yield* makeOrg.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    yield* ctx.provide(OrgService, org)
    const sessionTools = yield* makeSessionTools(ctx.pluginsSettled)
    const assistantMissing = yield* SubscriptionRef.make<ReadonlyArray<MissingReference>>([])
    const gitOps = yield* Ref.make(Option.none<GitOps>())
    const worktrees = yield* makeIssueWorkspace({
      projectOf: (projectId) => projectOf(workspace, projectId),
      gitOps: Ref.get(gitOps)
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    const dispatcher = yield* makeDispatcher({
      org,
      projectDirectory: (objective) => directoryOf(workspace, objective.projectId),
      issueWorkspace: worktrees,
      attach: ctx.sessions.attach,
      sessionTools
    })
    yield* followWorkspace(ctx, workspace, dispatcher)
    const backend = yield* Ref.make(Option.none<AgentBackend>())
    yield* holdAgentBackend(ctx, backend, dispatcher)
    yield* holdGitOps(ctx, gitOps, dispatcher)
    yield* holdRegistries(ctx, org, sessionTools, sql)
    yield* runIssues(ctx, { sql, org, workspace, dispatcher, sessionTools, assistantMissing })
    yield* serveOrgCalls(ctx, org, backend, dispatcher, worktrees)
    yield* serveLiveCalls(ctx, dispatcher, assistantMissing)
    const jobTitles = yield* org.jobTitles
    const hires = yield* org.hiredAgents
    yield* Effect.logInfo('Org service provided', {
      plugin: ctx.name,
      jobTitles: jobTitles.length,
      hiredAgents: hires.length
    })
  })

export default setup

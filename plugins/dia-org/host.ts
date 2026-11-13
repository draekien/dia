import {
  type GitOps,
  type HostPluginContext,
  type PluginSetup,
  type ProjectId,
  RunsKey,
  type ToolScope,
  WorktreesKey
} from '@dia/plugin'
import {
  type AgentDefinitionRegistry,
  AgentDefinitionRegistryKey
} from '@dia-plugin/dia-agent-definitions/registry'
import { ObjectiveId } from '@dia-plugin/dia-issues/domain'
import {
  type Issues,
  IssuesKey,
  isIssueToolScope,
  type ProviderIssues
} from '@dia-plugin/dia-issues/service'
import { McpServerRegistryKey } from '@dia-plugin/dia-mcp/registry'
import { type RunQueue, RunQueueKey } from '@dia-plugin/dia-run-queue/queue'
import { type AgentBackend, AgentBackendKey } from '@dia-plugin/dia-runs/backend'
import { ToolsKey } from '@dia-plugin/dia-tools/tools'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Option,
  Path,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef
} from 'effect'
import { SqlClient } from 'effect/sql'
import { orgAssignees } from './assignees'
import { ASSISTANT_LABEL, enabledAssistantOf, makeAssistant } from './assistant'
import { BUILT_IN_DEFINITIONS } from './built-in-job-titles'
import { bypassAvailable } from './bypass'
import {
  AskAssistant,
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
  StaffTeam,
  StartOverAssistant,
  WatchOrgLive
} from './calls'
import { agentName, jobTitleName, ORG_PROVIDER } from './domain'
import { handOverJobTitles, handOverWork, handoverPending, workHandoverPending } from './handover'
import { runIssues } from './issue-runs'
import { type IssueWorkspace, makeIssueWorkspace, moveIssueWorktrees } from './issue-workspace'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { makeRoutingTools } from './routing-tools'
import { issueStartOptions } from './run-options'
import { type Org, OrgService } from './service'

type Workspace = Stream.Success<HostPluginContext['workspace']>

type OrgWorkspace = Effect.Success<ReturnType<typeof makeIssueWorkspace>>

interface LiveRefs {
  readonly assistantRunId: SubscriptionRef.SubscriptionRef<string | null>
  readonly teamHasWork: SubscriptionRef.SubscriptionRef<boolean>
}

const watchOrgLive = (org: Org, live: LiveRefs) =>
  Effect.gen(function* () {
    const jobTitleChanges = yield* org.watchJobTitleChanges
    const assistantEnabled = Stream.merge(Stream.make(undefined), jobTitleChanges).pipe(
      Stream.mapEffect(() => org.jobTitles),
      Stream.map((jobTitles) => Option.isSome(enabledAssistantOf(jobTitles)))
    )
    return Stream.zipLatestAll(
      assistantEnabled,
      SubscriptionRef.changes(live.assistantRunId),
      SubscriptionRef.changes(live.teamHasWork)
    ).pipe(
      Stream.changesWith(
        ([enabledA, runA, workA], [enabledB, runB, workB]) =>
          enabledA === enabledB && runA === runB && workA === workB
      ),
      Stream.map(([enabled, runId, teamHasWork]) => ({
        assistantEnabled: enabled,
        assistantRunId: runId,
        teamHasWork
      }))
    )
  }).pipe(Stream.unwrap)

const followTeamWork = (
  org: Org,
  runs: Pick<ProviderIssues, 'countOpenIssues'>,
  issues: Issues,
  teamHasWork: LiveRefs['teamHasWork']
) =>
  Effect.gen(function* () {
    const hireChanges = yield* org.watchHireChanges
    const workChanges = yield* issues.watchChanges
    yield* Effect.addFinalizer(() => SubscriptionRef.set(teamHasWork, false))
    const refresh = Effect.gen(function* () {
      const hires = yield* org.hiredAgents
      const working = yield* Effect.findFirst(hires, (hire) =>
        Effect.map(runs.countOpenIssues(hire.id), (open) => open > 0)
      )
      const hasWork = Option.isSome(working)
      if ((yield* SubscriptionRef.getAndSet(teamHasWork, hasWork)) !== hasWork) {
        yield* Effect.logDebug('Org team work changed', { teamHasWork: hasWork })
      }
    })
    yield* Stream.merge(Stream.make(undefined), Stream.merge(hireChanges, workChanges)).pipe(
      Stream.runForEach(() => refresh),
      Effect.forkScoped
    )
  })

const hold = <A>(ref: Ref.Ref<Option.Option<A>>, value: A, service: string) =>
  Effect.acquireRelease(
    Ref.set(ref, Option.some(value)).pipe(
      Effect.tap(() => Effect.logDebug('Org holds a provided service', { service }))
    ),
    () => Ref.set(ref, Option.none())
  )

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

const isAssistantScope = (scope: ToolScope) => scope.labels.includes(ASSISTANT_LABEL)

interface RunDeps {
  readonly sql: SqlClient.SqlClient
  readonly org: Org
  readonly work: Issues
  readonly provider: ProviderIssues
  readonly workspace: Ref.Ref<Option.Option<Workspace>>
  readonly issueWorkspace: IssueWorkspace
  readonly assistantRunId: LiveRefs['assistantRunId']
}

const runOnFoundation = (ctx: HostPluginContext, deps: RunDeps) =>
  ctx
    .whenProvided(
      [RunsKey, RunQueueKey, AgentBackendKey],
      ({ runs, 'run-queue': queue, agentBackend }) =>
        Effect.gen(function* () {
          const issueRuns = yield* runIssues({
            org: deps.org,
            issues: deps.work,
            provider: deps.provider,
            workspace: deps.issueWorkspace,
            startOptions: issueStartOptions(deps.issueWorkspace, agentBackend),
            runs,
            queue,
            ready: ctx.pluginsSettled
          })
          const directory = (yield* Path.Path).join(ctx.dataDir, 'assistant')
          yield* (yield* FileSystem.FileSystem).makeDirectory(directory, { recursive: true })
          const assistant = yield* makeAssistant({
            org: deps.org,
            work: deps.work,
            runs,
            backend: agentBackend,
            directory,
            runId: deps.assistantRunId
          })
          yield* ctx.serve(AskAssistant, ({ text }) => assistant.ask(text))
          yield* ctx.serve(StartOverAssistant, () => assistant.startOver)
          const crypto = yield* Crypto.Crypto
          const routingTools = makeRoutingTools({
            work: deps.work,
            projects: routingProjects(deps.workspace),
            hires: routingHires(deps.org),
            newObjectiveId: crypto.randomUUIDv4().pipe(Effect.orDie, Effect.map(ObjectiveId.make)),
            claim: assistant.claim,
            deliver: issueRuns.deliver
          })
          yield* ctx.whenProvided([ToolsKey], ({ tools }) =>
            Effect.forEach(
              routingTools,
              (tool) => tools.register(tool, { when: isAssistantScope }),
              { discard: true }
            ).pipe(Effect.tap(() => Effect.logInfo('Org routing tools registered')))
          )
          yield* Effect.logInfo('Org runs its hired agents through the run queue')
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, deps.sql),
          Effect.provide([NodeServices.layer, NodeCrypto.layer])
        )
    )
    .pipe(Effect.orDie)

const runIssuesOnFoundation = (
  ctx: HostPluginContext,
  deps: Omit<RunDeps, 'work' | 'provider'> & { readonly teamHasWork: LiveRefs['teamHasWork'] }
) =>
  Effect.gen(function* () {
    if (yield* workHandoverPending.pipe(Effect.provideService(SqlClient.SqlClient, deps.sql))) {
      yield* Effect.logInfo('Org objectives and issues wait for issues to hand over')
    }
    yield* ctx.whenProvided([IssuesKey], ({ issues }) =>
      Effect.gen(function* () {
        yield* handOverWork(issues).pipe(Effect.provideService(SqlClient.SqlClient, deps.sql))
        const provider = yield* issues.registerProvider({
          id: ORG_PROVIDER,
          label: 'Org',
          assignees: orgAssignees(deps.org)
        })
        yield* deps.org.holdIssues(provider)
        yield* followTeamWork(deps.org, provider, issues, deps.teamHasWork)
        yield* ctx.whenProvided([ToolsKey], ({ tools }) =>
          Effect.forEach(
            provider.issueTools,
            (tool) => tools.register(tool, { when: isIssueToolScope }),
            { discard: true }
          ).pipe(Effect.tap(() => Effect.logInfo('Org issue tools registered')))
        )
        yield* runOnFoundation(ctx, { ...deps, work: issues, provider })
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

const holdRegistries = (ctx: HostPluginContext, org: Org, sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* ctx.whenProvided([AgentDefinitionRegistryKey], ({ agentDefinitionRegistry }) =>
      Effect.gen(function* () {
        yield* org.holdDefinitions(agentDefinitionRegistry)
        yield* registerBuiltIns(ctx, agentDefinitionRegistry)
      })
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

const followWorkspace = (ctx: HostPluginContext, workspace: Ref.Ref<Option.Option<Workspace>>) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>()
    yield* ctx.workspace.pipe(
      Stream.changesWith(
        (previous, current) => projectDirectories(previous) === projectDirectories(current)
      ),
      Stream.runForEach((current) =>
        Ref.set(workspace, Option.some(current)).pipe(
          Effect.andThen(Deferred.succeed(first, undefined))
        )
      ),
      Effect.forkScoped
    )
    yield* Deferred.await(first)
  })

const projectOf = (workspace: Ref.Ref<Option.Option<Workspace>>, projectId: ProjectId) =>
  Effect.map(Ref.get(workspace), (current) =>
    Option.flatMap(current, (value) =>
      Option.fromNullishOr(
        value.projects.find((entry) => entry.project.projectId === projectId)?.project
      )
    )
  )

const applyCap = (org: Org, queue: Ref.Ref<Option.Option<RunQueue>>) =>
  Effect.gen(function* () {
    const current = yield* Ref.get(queue)
    if (Option.isNone(current)) return
    const { overallCap } = yield* org.settings
    yield* current.value.setLimit(overallCap)
  })

const serveOrgCalls = (
  ctx: HostPluginContext,
  org: Org,
  backend: Ref.Ref<Option.Option<AgentBackend>>,
  queue: Ref.Ref<Option.Option<RunQueue>>,
  worktrees: Pick<OrgWorkspace, 'worktreeProjects' | 'setWorktreeProjects'>
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
      ctx.serve(StaffTeam, ({ plan }) => org.staffTeam(plan)),
      ctx.serve(Dismiss, ({ hireId }) => org.dismiss(hireId)),
      ctx.serve(RenameHire, ({ hireId, name }) => org.renameHire(hireId, name)),
      ctx.serve(SetBypassOverride, ({ hireId, override }) =>
        org.setBypassOverride(hireId, override)
      ),
      ctx.serve(SetReportsTo, ({ hireId, reportsTo }) => org.setReportsTo(hireId, reportsTo)),
      ctx.serve(SetOverallCap, ({ cap }) =>
        org.setOverallCap(cap).pipe(Effect.tap(() => applyCap(org, queue)))
      ),
      ctx.serve(SetProjectWorktrees, ({ projectId, enabled }) =>
        worktrees
          .setWorktreeProjects(projectId, enabled)
          .pipe(Effect.andThen(worktrees.worktreeProjects))
      )
    ],
    { discard: true }
  )

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(orgMigrations)
    yield* ctx.onPathsMoved((move) =>
      moveIssueWorktrees(move).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    )
    const workspace = yield* Ref.make(Option.none<Workspace>())
    const org = yield* makeOrg.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    yield* ctx.provide(OrgService, org)
    const live: LiveRefs = {
      assistantRunId: yield* SubscriptionRef.make<string | null>(null),
      teamHasWork: yield* SubscriptionRef.make(false)
    }
    const gitOps = yield* Ref.make(Option.none<GitOps>())
    const issueWorkspace = yield* makeIssueWorkspace({
      projectOf: (projectId) => projectOf(workspace, projectId),
      gitOps: Ref.get(gitOps)
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
    yield* followWorkspace(ctx, workspace)
    const backend = yield* Ref.make(Option.none<AgentBackend>())
    const queue = yield* Ref.make(Option.none<RunQueue>())
    yield* ctx.whenProvided([AgentBackendKey], ({ agentBackend }) =>
      hold(backend, agentBackend, 'agent backend')
    )
    yield* ctx.whenProvided([WorktreesKey], ({ worktrees }) => hold(gitOps, worktrees, 'worktrees'))
    yield* ctx.whenProvided([RunQueueKey], ({ 'run-queue': provided }) =>
      hold(queue, provided, 'run queue').pipe(Effect.andThen(applyCap(org, queue)))
    )
    yield* holdRegistries(ctx, org, sql)
    yield* runIssuesOnFoundation(ctx, {
      sql,
      org,
      workspace,
      issueWorkspace,
      assistantRunId: live.assistantRunId,
      teamHasWork: live.teamHasWork
    })
    yield* serveOrgCalls(ctx, org, backend, queue, issueWorkspace)
    yield* ctx.serve(WatchOrgLive, () => watchOrgLive(org, live))
    const jobTitles = yield* org.jobTitles
    const hires = yield* org.hiredAgents
    yield* Effect.logInfo('Org service provided', {
      plugin: ctx.name,
      jobTitles: jobTitles.length,
      hiredAgents: hires.length
    })
  })

export default setup

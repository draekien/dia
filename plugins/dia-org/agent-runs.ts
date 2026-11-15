import { AGENT_NAME_MAX_LENGTH, AgentName } from '@dia/plugin'
import { type Issue, isStarted, type Objective } from '@dia-plugin/dia-issues/domain'
import type { Issues } from '@dia-plugin/dia-issues/service'
import { Effect, Schema, Stream } from 'effect'
import { AgentRun } from './calls'
import type { HiredAgent, JobTitle } from './domain'
import type { Org } from './service'

/** The run a hire has for an issue, as `runIssues` stores it. */
export interface IssueRunRef {
  readonly issueId: string
  readonly hireId: string
  readonly runId: string
}

/** A project's id and the name the sidebar shows for it. */
export interface ProjectName {
  readonly projectId: string
  readonly displayName: string
}

/** What {@link agentRunsOf} joins into the {@link AgentRun}s. */
export interface AgentRunSources {
  readonly runs: ReadonlyArray<IssueRunRef>
  readonly snapshot: {
    readonly issues: ReadonlyArray<Pick<Issue, 'id' | 'objectiveId' | 'title' | 'status'>>
    readonly objectives: ReadonlyArray<Pick<Objective, 'id' | 'projectId'>>
  }
  readonly projects: ReadonlyArray<ProjectName>
  readonly hires: ReadonlyArray<Pick<HiredAgent, 'id' | 'name' | 'jobTitleId'>>
  readonly jobTitles: ReadonlyArray<Pick<JobTitle, 'id' | 'name'>>
}

const SEPARATOR = ' · '
const ELLIPSIS = '…'

/**
 * The name of the tab that shows a hire's run of an issue: `<assignee> · <issueTitle>`, where
 * `assignee` is the hire's name or its job title's name. The issue title is shortened with an
 * ellipsis so the name fits {@link AGENT_NAME_MAX_LENGTH}.
 */
export const issueRunTabName = (assignee: string, issueTitle: string): AgentName => {
  const prefix = `${assignee.trim()}${SEPARATOR}`
  const title = issueTitle.trim()
  const room = AGENT_NAME_MAX_LENGTH - prefix.length
  const full = `${prefix}${title}`
  if (full.length <= AGENT_NAME_MAX_LENGTH) return AgentName.make(full)
  if (room <= ELLIPSIS.length)
    return AgentName.make(assignee.trim().slice(0, AGENT_NAME_MAX_LENGTH))
  return AgentName.make(`${prefix}${title.slice(0, room - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`)
}

/**
 * The {@link AgentRun}s for `sources`, ordered by issue title: one per stored run whose issue is in
 * a started status and whose hire is still hired. A project that is no longer registered is named
 * `Removed project`.
 */
export const agentRunsOf = (sources: AgentRunSources): ReadonlyArray<AgentRun> => {
  const issues = new Map(sources.snapshot.issues.map((issue) => [issue.id as string, issue]))
  const objectives = new Map(
    sources.snapshot.objectives.map((objective) => [objective.id as string, objective])
  )
  const projects = new Map(sources.projects.map((project) => [project.projectId, project]))
  const hires = new Map(sources.hires.map((hire) => [hire.id as string, hire]))
  const jobTitles = new Map(sources.jobTitles.map((title) => [title.id as string, title.name]))
  return sources.runs
    .flatMap((run) => {
      const issue = issues.get(run.issueId)
      const hire = hires.get(run.hireId)
      if (issue === undefined || hire === undefined || !isStarted(issue.status)) return []
      const projectId = objectives.get(issue.objectiveId)?.projectId
      const project = projectId === undefined ? undefined : projects.get(projectId)
      return [
        AgentRun.make({
          runId: run.runId,
          issueTitle: issue.title,
          projectName: project?.displayName ?? 'Removed project',
          assignee: hire.name ?? jobTitles.get(hire.jobTitleId) ?? 'agent'
        })
      ]
    })
    .sort((a, b) => a.issueTitle.localeCompare(b.issueTitle))
}

/** What {@link watchAgentRuns} reads and follows. */
export interface AgentRunsDeps {
  readonly runs: Effect.Effect<ReadonlyArray<IssueRunRef>>
  readonly issues: Pick<Issues, 'snapshot' | 'watchChanges'>
  readonly org: Pick<Org, 'hiredAgents' | 'jobTitles' | 'watchHireChanges' | 'watchJobTitleChanges'>
  readonly projects: Stream.Stream<ReadonlyArray<ProjectName>>
}

const sameAgentRuns = Schema.toEquivalence(Schema.Array(AgentRun))

/**
 * Streams the {@link AgentRun}s: the current list once `deps.projects` has emitted, then a new
 * list after each change of issues, hires, job titles or projects that changes it.
 */
export const watchAgentRuns = (deps: AgentRunsDeps): Stream.Stream<ReadonlyArray<AgentRun>> =>
  Effect.gen(function* () {
    const changes = Stream.mergeAll(
      [
        Stream.make(undefined),
        yield* deps.issues.watchChanges,
        yield* deps.org.watchHireChanges,
        yield* deps.org.watchJobTitleChanges
      ],
      { concurrency: 'unbounded' }
    )
    const sources = changes.pipe(
      Stream.mapEffect(() =>
        Effect.all({
          runs: deps.runs,
          snapshot: deps.issues.snapshot,
          hires: deps.org.hiredAgents,
          jobTitles: deps.org.jobTitles
        })
      )
    )
    return Stream.zipLatest(sources, deps.projects).pipe(
      Stream.map(([read, projects]) => agentRunsOf({ ...read, projects })),
      Stream.changesWith(sameAgentRuns),
      Stream.tap((runs) => Effect.logDebug('Org agent runs changed', { runs: runs.length }))
    )
  }).pipe(Stream.unwrap)

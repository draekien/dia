import { type PermissionMode, type StartRunOptions, startPermissionMode } from '@dia/plugin'
import type { Issue, Objective } from '@dia-plugin/dia-issues/domain'
import type { AgentBackend } from '@dia-plugin/dia-runs/backend'
import { Effect, Option, Stream } from 'effect'
import type { HiredAgent, JobTitle } from './domain'
import type { IssueWorkspace } from './issue-workspace'

/** The agent backend reads a run's start options need; it never opens a session. */
export type BackendReads = Pick<AgentBackend, 'models' | 'disabledPermissionModes'>

const PLANNING_STEPS = `Break it into issues with create_issue: one per piece of work another agent can finish on its own,
each with a description it can act on. They go to Triage for the user to accept.
When the plan is complete, set this issue to in_review with update_issue.`

/** `parts` joined as paragraphs, skipping empty ones. */
export const paragraphs = (...parts: ReadonlyArray<string>) =>
  parts.filter((part) => part !== '').join('\n\n')

/** The first message of a hire's run of `issue`: its job description, then the work (ADR-0080). */
export const issuePrompt = (issue: Issue, objective: Objective, jobTitle: JobTitle): string =>
  issue.kind === 'planning'
    ? paragraphs(
        jobTitle.jobDescription,
        `Plan the objective "${objective.title}".`,
        objective.description,
        PLANNING_STEPS
      )
    : paragraphs(
        jobTitle.jobDescription,
        issue.title,
        issue.description,
        `Issue: ${issue.id}\nObjective: ${objective.title}`,
        objective.description
      )

/**
 * The model, thinking level and permission mode a run of `jobTitle` starts with in `cwd`: the job
 * title's model or the catalog's first, and the mode `startPermissionMode` gives (ADR-0054), with
 * `bypassOptedIn` the hire's override or the job title's opt-in. Waits until the model catalog is
 * ready.
 */
export const runSettings = Effect.fn('Org.runSettings')(function* (
  backend: BackendReads,
  jobTitle: JobTitle,
  cwd: string,
  bypassOptedIn: boolean
) {
  const catalog = yield* backend.models().pipe(
    Stream.filter((state) => state._tag === 'Ready'),
    Stream.runHead,
    Effect.map(Option.map((state) => state.models))
  )
  const models = Option.getOrElse(catalog, () => [])
  const model = jobTitle.model ?? models[0]?.value ?? 'default'
  const input = {
    modelSupportsAuto: models.find((option) => option.value === model)?.autoMode ?? false,
    disabled: yield* backend.disabledPermissionModes(cwd),
    bypassOptedIn
  }
  const permissionMode: PermissionMode = startPermissionMode(input)
  yield* Effect.logInfo('Chose a run permission mode', { model, ...input, permissionMode })
  return { model, thinkingLevel: jobTitle.thinkingLevel, permissionMode }
})

/**
 * The {@link StartRunOptions} of `hire`'s run of `issue`, or none while its workspace waits (the
 * project is not registered, or the worktree cannot be created yet). Opens the issue's worktree
 * when its project runs issues in worktrees.
 */
export const issueStartOptions =
  (workspace: Pick<IssueWorkspace, 'open'>, backend: BackendReads) =>
  (issue: Issue, objective: Objective, hire: HiredAgent, jobTitle: JobTitle) =>
    Effect.gen(function* () {
      const cwd = yield* workspace.open(issue, objective)
      if (cwd._tag === 'IssueWaiting') {
        yield* Effect.logWarning('Issue waits for its workspace', {
          issueId: issue.id,
          reason: cwd.reason
        })
        return Option.none<StartRunOptions>()
      }
      const settings = yield* runSettings(
        backend,
        jobTitle,
        cwd.path,
        hire.bypassOverride ?? jobTitle.bypassOptIn
      )
      return Option.some<StartRunOptions>({
        cwd: cwd.path,
        ...settings,
        text: issuePrompt(issue, objective, jobTitle)
      })
    })

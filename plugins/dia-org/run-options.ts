import { type Runs, type StartRunOptions, startPermissionMode } from '@dia/plugin'
import type { AgentAdapters } from '@dia-plugin/dia-agent-adapters/registry'
import type { Issue, Objective } from '@dia-plugin/dia-issues/domain'
import { Effect, Option, Stream } from 'effect'
import { type HiredAgent, type JobTitle, NO_AGENT_ADAPTER_MESSAGE } from './domain'
import type { IssueWorkspace } from './issue-workspace'

/**
 * How a hire's run of an issue starts: `run`, the options it starts with, and
 * `projectDirectory`, the directory of the issue's project, whose group shows the run's tab.
 */
export interface IssueStart {
  readonly run: StartRunOptions
  readonly projectDirectory: string
}

/** The run options {@link runSettings} chooses; the caller adds `cwd`, the prompt and the rest. */
export type RunSettings = Pick<
  StartRunOptions,
  'model' | 'backend' | 'thinkingLevel' | 'permissionMode'
>

/**
 * What a run's start options are chosen from: `adapters` to find the backend of the selection's
 * adapter, and `defaultSelection`, the model of a caller that has no selection of its own.
 */
export interface RunChoices {
  readonly adapters: Pick<AgentAdapters, 'get' | 'models'>
  readonly defaultSelection: Runs['defaultSelection']
}

const PLANNING_STEPS = `Break it into issues with create_issue: one per piece of work another agent can finish on its own,
each with a description it can act on. They go to Triage for the user to accept.
When the plan is complete, set this issue to in_review with update_issue.`

/** `parts` joined as paragraphs, skipping empty ones. */
export const paragraphs = (...parts: ReadonlyArray<string>) =>
  parts.filter((part) => part !== '').join('\n\n')

const workIssuePrompt = (issue: Issue, objective: Objective): string => {
  const repeatsObjective =
    objective.title === issue.title && objective.description === issue.description
  return repeatsObjective
    ? paragraphs(issue.title, issue.description, `Issue: ${issue.id}`)
    : paragraphs(
        issue.title,
        issue.description,
        `Issue: ${issue.id}\nObjective: ${objective.title}`,
        objective.description
      )
}

/**
 * The first message of a hire's run of `issue`: the work, without the job description (ADR-0082).
 * The objective's title and description are left out when both equal the issue's own, so an
 * objective routed straight to one hire reads once.
 */
export const issuePrompt = (issue: Issue, objective: Objective): string =>
  issue.kind === 'planning'
    ? paragraphs(`Plan the objective "${objective.title}".`, objective.description, PLANNING_STEPS)
    : workIssuePrompt(issue, objective)

/**
 * The model, backend, thinking level and permission mode a run of `jobTitle` starts with in
 * `cwd`, or none when the job title has no selection and no adapter is loaded to give a default.
 * The model is the job title's selection or `choices.defaultSelection`; the permission mode is the
 * one `startPermissionMode` gives (ADR-0054), with `bypassOptedIn` the hire's override or the job
 * title's opt-in. Waits until the selection's adapter has a ready model list; an adapter that is
 * not registered does not wait, and its run ends with the adapter's not-loaded message.
 */
export const runSettings = Effect.fn('Org.runSettings')(function* (
  choices: RunChoices,
  jobTitle: JobTitle,
  cwd: string,
  bypassOptedIn: boolean
) {
  const selection =
    jobTitle.selection === null
      ? Option.getOrNull(yield* choices.defaultSelection)
      : jobTitle.selection
  if (selection === null) {
    yield* Effect.logWarning(NO_AGENT_ADAPTER_MESSAGE, { jobTitle: jobTitle.name })
    return Option.none<RunSettings>()
  }
  const adapter = yield* choices.adapters.get(selection.backend)
  const catalog = Option.isNone(adapter)
    ? Option.none()
    : yield* choices.adapters.models(selection.backend).pipe(
        Stream.filter((state) => state._tag === 'Ready'),
        Stream.runHead,
        Effect.map(Option.map((state) => state.models))
      )
  const models = Option.getOrElse(catalog, () => [])
  const input = {
    modelSupportsAuto: models.find((option) => option.value === selection.model)?.autoMode ?? false,
    disabled: Option.isNone(adapter)
      ? []
      : yield* adapter.value.backend.disabledPermissionModes(cwd),
    bypassOptedIn
  }
  const permissionMode = startPermissionMode(input)
  yield* Effect.logInfo('Chose a run permission mode', { ...selection, ...input, permissionMode })
  return Option.some<RunSettings>({
    model: selection.model,
    backend: selection.backend,
    thinkingLevel: jobTitle.thinkingLevel,
    permissionMode
  })
})

/**
 * The {@link IssueStart} of `hire`'s run of `issue`, or none while its workspace waits (the
 * project is not registered, or the worktree cannot be created yet). Opens the issue's worktree
 * when its project runs issues in worktrees.
 */
export const issueStartOptions =
  (workspace: Pick<IssueWorkspace, 'open'>, choices: RunChoices) =>
  (issue: Issue, objective: Objective, hire: HiredAgent, jobTitle: JobTitle) =>
    Effect.gen(function* () {
      const cwd = yield* workspace.open(issue, objective)
      if (cwd._tag === 'IssueWaiting') {
        yield* Effect.logWarning('Issue waits for its workspace', {
          issueId: issue.id,
          reason: cwd.reason
        })
        return Option.none<IssueStart>()
      }
      const settings = yield* runSettings(
        choices,
        jobTitle,
        cwd.path,
        hire.bypassOverride ?? jobTitle.bypassOptIn
      )
      if (Option.isNone(settings)) return Option.none<IssueStart>()
      return Option.some<IssueStart>({
        run: {
          cwd: cwd.path,
          ...settings.value,
          text: issuePrompt(issue, objective),
          systemPromptAppend: jobTitle.jobDescription,
          permissions: jobTitle.permissions
        },
        projectDirectory: cwd.projectDirectory
      })
    })

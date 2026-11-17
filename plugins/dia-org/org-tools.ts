import {
  AgentName,
  type DiaTool,
  type DiaToolResult,
  diaTool,
  type PermissionRules,
  type ToolInput,
  type ToolScope
} from '@dia/plugin'
import { result } from '@dia-plugin/dia-issues/tool-input'
import type { ApprovalRequest, Tools } from '@dia-plugin/dia-tools/tools'
import { Data, Effect, Schema, Struct } from 'effect'
import {
  agentName,
  type BuiltInJobTitleDeleted,
  type BuiltInJobTitleRenamed,
  type HireHasOpenIssues,
  HireId,
  type HireNameTaken,
  type HireNotFound,
  type IssuesNotLoaded,
  type JobTitle,
  type JobTitleDisabled,
  type JobTitleEdit,
  JobTitleFields,
  type JobTitleHasHires,
  JobTitleId,
  JobTitleName,
  type JobTitleNameTaken,
  JobTitleNotFound,
  type JobTitleNotHireable,
  type JobTitlesNotLoaded,
  type ReportsToCycle,
  TeamPlan
} from './domain'
import type { Org } from './service'

/** What the org tools read and change, and how they ask the user to approve a call. */
export interface OrgToolDeps {
  readonly org: Pick<
    Org,
    | 'jobTitles'
    | 'hiredAgents'
    | 'hire'
    | 'staffTeam'
    | 'renameHire'
    | 'setReportsTo'
    | 'dismiss'
    | 'createJobTitle'
    | 'editJobTitle'
    | 'copyJobTitle'
    | 'setJobTitleEnabled'
    | 'deleteJobTitle'
  >
  readonly requestApproval: Tools['requestApproval']
}

class Declined extends Data.TaggedError('Declined')<{ readonly title: string }> {}

type OrgRefusal =
  | JobTitleNotFound
  | JobTitleNameTaken
  | BuiltInJobTitleRenamed
  | BuiltInJobTitleDeleted
  | JobTitleHasHires
  | JobTitleDisabled
  | JobTitleNotHireable
  | HireNotFound
  | HireNameTaken
  | ReportsToCycle
  | HireHasOpenIssues
  | IssuesNotLoaded
  | JobTitlesNotLoaded

const READ_FIRST = 'Call org_read first and use the ids it returns.'

const refusalText = (error: OrgRefusal): string => {
  switch (error._tag) {
    case 'JobTitleNotFound':
      return `No job title has id "${error.jobTitleId}". ${READ_FIRST}`
    case 'JobTitleNameTaken':
      return `A job title named "${error.jobTitleName}" already exists.`
    case 'BuiltInJobTitleRenamed':
      return 'A built-in job title cannot be renamed; copy it under a new name instead.'
    case 'BuiltInJobTitleDeleted':
      return 'A built-in job title cannot be deleted; disable it instead.'
    case 'JobTitleHasHires':
      return `The job title has ${error.hires} hired agents; dismiss them first.`
    case 'JobTitleDisabled':
      return 'The job title is disabled; enable it before hiring into it.'
    case 'JobTitleNotHireable':
      return 'The Executive assistant job title cannot be hired.'
    case 'HireNotFound':
      return `No hired agent has id "${error.hireId}". ${READ_FIRST}`
    case 'HireNameTaken':
      return `A hired agent named "${error.agentName}" already exists.`
    case 'ReportsToCycle':
      return 'That reporting line would make the agent report to itself or to one of its own reports.'
    case 'HireHasOpenIssues':
      return `The agent has ${error.issues} open issues; finish or cancel them before dismissing it.`
    case 'IssuesNotLoaded':
      return 'The org cannot check the agent’s issues yet; try again shortly.'
    case 'JobTitlesNotLoaded':
      return 'The org’s job titles are not loaded yet; try again shortly.'
  }
}

const orgCall =
  (tool: string) =>
  (effect: Effect.Effect<string, OrgRefusal | Declined>): Effect.Effect<DiaToolResult> =>
    Effect.logInfo('Org tool called', { tool }).pipe(
      Effect.andThen(effect),
      Effect.tap(() => Effect.logInfo('Org tool call succeeded', { tool })),
      Effect.map((text) => result(text)),
      Effect.catchTag('Declined', (declined) =>
        Effect.logInfo('Org tool call declined by the user', { tool }).pipe(
          Effect.as(result(`The user declined "${declined.title}"; nothing changed.`, true))
        )
      ),
      Effect.catch((error) =>
        Effect.logInfo('Org tool refused the call', { tool, reason: error._tag }).pipe(
          Effect.as(result(refusalText(error), true))
        )
      ),
      Effect.catchCause((cause) =>
        Effect.logError('Org tool failed', { tool }, cause).pipe(
          Effect.as(result(`The ${tool} call failed.`, true))
        )
      )
    )

const orgTool = <S extends ToolInput>(tool: {
  readonly name: string
  readonly description: string
  readonly input: S
  readonly run: (input: S['Type'], scope: ToolScope) => Effect.Effect<string, OrgRefusal | Declined>
}): DiaTool =>
  diaTool({ ...tool, run: (input, scope) => orgCall(tool.name)(tool.run(input, scope)) })

const definitionFields = (jobTitle: JobTitle): JobTitleFields =>
  Struct.omit(jobTitle, ['id', 'builtIn', 'enabled'])

const show = (value: object): string => JSON.stringify(value, null, 2)

const hasRules = (rules: PermissionRules): boolean =>
  rules.allow.length + rules.ask.length + rules.deny.length > 0

const grantsAccess = (change: Partial<Pick<JobTitleFields, 'permissions' | 'bypassOptIn'>>) =>
  (change.permissions !== undefined && hasRules(change.permissions)) || change.bypassOptIn === true

const isAssistant = (jobTitle: JobTitle): boolean => jobTitle.builtIn === 'executive-assistant'

const askUser = (deps: OrgToolDeps, scope: ToolScope, request: ApprovalRequest) =>
  Effect.gen(function* () {
    const answer = yield* deps.requestApproval(scope, request)
    yield* Effect.logInfo('Org tool approval answered', { title: request.title, answer })
    if (answer === 'declined') return yield* new Declined({ title: request.title })
  })

const findJobTitle = (deps: OrgToolDeps, jobTitleId: JobTitleId) =>
  Effect.gen(function* () {
    const jobTitle = (yield* deps.org.jobTitles).find((entry) => entry.id === jobTitleId)
    if (jobTitle === undefined) return yield* new JobTitleNotFound({ jobTitleId })
    return jobTitle
  })

const jobTitleIdField = JobTitleId.annotate({ description: `Id of the job title. ${READ_FIRST}` })
const hireIdField = HireId.annotate({ description: `Id of the hired agent. ${READ_FIRST}` })

const definitionField = {
  name: JobTitleFields.fields.name.annotate({
    description: 'Name of the job title, 1-40 characters, unique ignoring case.'
  }),
  jobDescription: JobTitleFields.fields.jobDescription.annotate({
    description: "The job description, appended to the system prompt of the job title's sessions."
  }),
  skills: JobTitleFields.fields.skills.annotate({
    description: 'Names of the skills its sessions get; empty for every skill.'
  }),
  permissions: JobTitleFields.fields.permissions.annotate({
    description:
      'Permission rules added to its sessions: allow, ask and deny lists of rule names such as mcp__dia__org_read or Bash(git status).'
  }),
  mcpServers: JobTitleFields.fields.mcpServers.annotate({
    description: 'Names of MCP servers configured in dia that its sessions get.'
  }),
  bypassOptIn: JobTitleFields.fields.bypassOptIn.annotate({
    description: 'Whether its sessions may start in bypassPermissions.'
  }),
  model: JobTitleFields.fields.model.annotate({
    description: 'Model its sessions open with; null for the first model dia lists.'
  }),
  thinkingLevel: JobTitleFields.fields.thinkingLevel.annotate({
    description: 'Thinking level its sessions open with.'
  })
}

const NEW_JOB_TITLE_DEFAULTS = {
  skills: [],
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: [],
  bypassOptIn: false,
  model: null,
  thinkingLevel: 'medium'
} as const satisfies Omit<JobTitleFields, 'name' | 'jobDescription'>

const readTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'org_read',
    description:
      "List every job title with its fields and whether it is enabled, and every hired agent with its job title and who it reports to. Call it before any other org tool and use the ids it returns. A hired agent's name is its stored name, null when unnamed; displayName is what the org shows.",
    input: Schema.Struct({}),
    run: () =>
      Effect.gen(function* () {
        const [jobTitles, hires] = yield* Effect.all([deps.org.jobTitles, deps.org.hiredAgents], {
          concurrency: 'unbounded'
        })
        const hiredAgents = hires.map((hire) => ({
          id: hire.id,
          name: hire.name,
          displayName: agentName(hire, jobTitles),
          jobTitleId: hire.jobTitleId,
          jobTitle: jobTitles.find((jobTitle) => jobTitle.id === hire.jobTitleId)?.name ?? null,
          reportsTo: hire.reportsTo
        }))
        return show({ jobTitles, hiredAgents })
      })
  })

const hireTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'hire',
    description: `Hire an agent of an enabled job title. ${READ_FIRST}`,
    input: Schema.Struct({
      jobTitleId: jobTitleIdField,
      name: Schema.optionalKey(
        AgentName.annotate({ description: 'Name of the agent; leave it out for an unnamed one.' })
      ),
      reportsTo: Schema.optionalKey(
        HireId.annotate({
          description: 'Id of the hired agent it reports to; leave it out to report to the user.'
        })
      )
    }),
    run: (input) =>
      Effect.gen(function* () {
        const hired = yield* deps.org.hire(
          input.jobTitleId,
          input.name ?? null,
          input.reportsTo ?? null
        )
        const jobTitles = yield* deps.org.jobTitles
        return `Hired ${agentName(hired, jobTitles)}, id ${hired.id}.`
      })
  })

const staffTeamTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'staff_team',
    description: `Hire a team in one step: a lead reporting to the user, and members reporting to the lead, or to the user when lead is null. Every hire is unnamed. Give at least one of lead or members. ${READ_FIRST}`,
    input: TeamPlan.annotate({ description: 'The job titles to hire.' }),
    run: (plan) =>
      Effect.gen(function* () {
        const hired = yield* deps.org.staffTeam(plan)
        return `Hired ${hired.length} agents: ${hired.map((hire) => hire.id).join(', ')}.`
      })
  })

const renameTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'hire_rename',
    description: `Name a hired agent, or clear its name with null. ${READ_FIRST}`,
    input: Schema.Struct({
      hireId: hireIdField,
      name: Schema.NullOr(AgentName).annotate({
        description: 'The new name, unique among hired agents ignoring case; null clears it.'
      })
    }),
    run: (input) =>
      Effect.gen(function* () {
        const renamed = yield* deps.org.renameHire(input.hireId, input.name)
        return renamed.name === null
          ? `Cleared the name of ${renamed.id}.`
          : `Named ${renamed.id} "${renamed.name}".`
      })
  })

const reportsToTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'hire_set_reports_to',
    description: `Make a hired agent report to another hired agent, or to the user with null. ${READ_FIRST}`,
    input: Schema.Struct({
      hireId: hireIdField,
      reportsTo: Schema.NullOr(HireId).annotate({
        description: 'Id of the hired agent it reports to; null for the user.'
      })
    }),
    run: (input) =>
      Effect.gen(function* () {
        const moved = yield* deps.org.setReportsTo(input.hireId, input.reportsTo)
        return moved.reportsTo === null
          ? `${moved.id} now reports to the user.`
          : `${moved.id} now reports to ${moved.reportsTo}.`
      })
  })

const dismissTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'hire_dismiss',
    description: `Dismiss a hired agent with no open issues; its reports move to its own manager. ${READ_FIRST}`,
    input: Schema.Struct({ hireId: hireIdField }),
    run: (input) => deps.org.dismiss(input.hireId).pipe(Effect.as(`Dismissed ${input.hireId}.`))
  })

const createTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'job_title_create',
    description:
      'Create an enabled job title. Fields left out get the defaults of a new job title: no skills, permission rules or MCP servers, no bypass opt-in, the first model and medium thinking. Permission rules or the bypass opt-in wait for the user to approve them.',
    input: Schema.Struct({
      name: definitionField.name,
      jobDescription: definitionField.jobDescription,
      ...Struct.map(Struct.omit(definitionField, ['name', 'jobDescription']), Schema.optionalKey)
    }),
    run: (input, scope) =>
      Effect.gen(function* () {
        const fields: JobTitleFields = { ...NEW_JOB_TITLE_DEFAULTS, ...input }
        if (grantsAccess(fields)) {
          yield* askUser(deps, scope, {
            title: `Create job title "${fields.name}"`,
            before: '',
            after: show(fields)
          })
        }
        const created = yield* deps.org.createJobTitle(fields)
        return `Created job title "${created.name}", id ${created.id}.`
      })
  })

const editTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'job_title_edit',
    description: `Change a job title's fields; fields left out stay as they are. A built-in job title keeps its name. A change to the Executive assistant, or one that sets permission rules or the bypass opt-in, waits for the user to approve it. ${READ_FIRST}`,
    input: Schema.Struct({
      jobTitleId: jobTitleIdField,
      ...Struct.map(definitionField, Schema.optionalKey)
    }),
    run: (input, scope) =>
      Effect.gen(function* () {
        const edit: JobTitleEdit = Struct.omit(input, ['jobTitleId'])
        const target = yield* findJobTitle(deps, input.jobTitleId)
        if (isAssistant(target) || grantsAccess(edit)) {
          const before = definitionFields(target)
          yield* askUser(deps, scope, {
            title: `Edit job title "${target.name}"`,
            before: show(before),
            after: show({ ...before, ...edit })
          })
        }
        const edited = yield* deps.org.editJobTitle(input.jobTitleId, edit)
        return `Edited job title "${edited.name}".`
      })
  })

const copyTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'job_title_copy',
    description: `Copy every field of a job title into a new enabled job title with a new name. ${READ_FIRST}`,
    input: Schema.Struct({
      jobTitleId: jobTitleIdField,
      name: JobTitleName.annotate({ description: 'Name of the copy, unique ignoring case.' })
    }),
    run: (input) =>
      Effect.gen(function* () {
        const copy = yield* deps.org.copyJobTitle(input.jobTitleId, input.name)
        return `Created job title "${copy.name}", id ${copy.id}.`
      })
  })

const setEnabledTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'job_title_set_enabled',
    description: `Enable or disable a job title; a disabled job title cannot be hired into. Changing the Executive assistant waits for the user to approve it. ${READ_FIRST}`,
    input: Schema.Struct({
      jobTitleId: jobTitleIdField,
      enabled: Schema.Boolean.annotate({ description: 'true to enable, false to disable.' })
    }),
    run: (input, scope) =>
      Effect.gen(function* () {
        const target = yield* findJobTitle(deps, input.jobTitleId)
        if (isAssistant(target)) {
          const before = { ...definitionFields(target), enabled: target.enabled }
          yield* askUser(deps, scope, {
            title: `${input.enabled ? 'Enable' : 'Disable'} job title "${target.name}"`,
            before: show(before),
            after: show({ ...before, enabled: input.enabled })
          })
        }
        const changed = yield* deps.org.setJobTitleEnabled(input.jobTitleId, input.enabled)
        return `${changed.enabled ? 'Enabled' : 'Disabled'} job title "${changed.name}".`
      })
  })

const deleteTool = (deps: OrgToolDeps): DiaTool =>
  orgTool({
    name: 'job_title_delete',
    description: `Delete a job title that is not built in and has no hired agents. ${READ_FIRST}`,
    input: Schema.Struct({ jobTitleId: jobTitleIdField }),
    run: (input) =>
      deps.org
        .deleteJobTitle(input.jobTitleId)
        .pipe(Effect.as(`Deleted job title ${input.jobTitleId}.`))
  })

/**
 * The Executive assistant's org tools (#293): `org_read`, `hire`, `staff_team`, `hire_rename`,
 * `hire_set_reports_to`, `hire_dismiss`, `job_title_create`, `job_title_edit`, `job_title_copy`,
 * `job_title_set_enabled` and `job_title_delete`. An `Org` refusal returns its reason with
 * `isError` set and changes nothing. A call that changes the Executive assistant job title, or
 * that sets a job title's `permissions` to non-empty rules or its `bypassOptIn` to true, first asks
 * the user through `requestApproval`; a decline returns an error result and changes nothing.
 * Register them with `dia-tools` for the Executive assistant's run scope.
 */
export const makeOrgTools = (deps: OrgToolDeps): ReadonlyArray<DiaTool> => [
  readTool(deps),
  hireTool(deps),
  staffTeamTool(deps),
  renameTool(deps),
  reportsToTool(deps),
  dismissTool(deps),
  createTool(deps),
  editTool(deps),
  copyTool(deps),
  setEnabledTool(deps),
  deleteTool(deps)
]

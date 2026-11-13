import { type DiaTool, type DiaToolResult, diaTool, type ProjectId } from '@dia/plugin'
import {
  AssigneeRef,
  type FirstIssue,
  ISSUE_DESCRIPTION_MAX_LENGTH,
  type Issue,
  isStarted,
  type Objective,
  type ObjectiveId,
  ObjectivePriority,
  WorkTitle
} from '@dia-plugin/dia-issues/domain'
import type { Issues } from '@dia-plugin/dia-issues/service'
import {
  decodeField,
  decodeOptional,
  type Input,
  InvalidInput,
  optional,
  present,
  required,
  result
} from '@dia-plugin/dia-issues/tool-input'
import { Effect, Schema } from 'effect'
import { DirectRoute, type HireId, ORG_PROVIDER, PlanRoute, prefixedTitle } from './domain'
import type { IssueRuns } from './issue-runs'

/** The most words a routing note may have (ADR-0053). */
export const ROUTING_NOTE_MAX_WORDS = 30

/** A registered project as the routing tools name it. */
export interface RoutingProject {
  readonly id: ProjectId
  readonly name: string
}

/** A hired agent as the routing tools name it: its display name and its job title's name. */
export interface RoutingHire {
  readonly id: HireId
  readonly name: string
  readonly jobTitle: string
}

/**
 * What the routing tools read and change. `projects` and `hires` read the current registered
 * projects and hired agents; `newObjectiveId` generates a fresh objective id on each run; `claim`
 * records that the Executive assistant created an objective, before it is created; `deliver` sends
 * a message to an issue's live run.
 */
export interface RoutingToolDeps {
  readonly work: Pick<Issues, 'snapshot' | 'createObjective' | 'stopObjective'>
  readonly projects: Effect.Effect<ReadonlyArray<RoutingProject>>
  readonly hires: Effect.Effect<ReadonlyArray<RoutingHire>>
  readonly newObjectiveId: Effect.Effect<ObjectiveId>
  readonly claim: (objectiveId: ObjectiveId) => Effect.Effect<void>
  readonly deliver: IssueRuns['deliver']
}

const byIdOrName = <A extends { readonly id: string; readonly name: string }>(
  entries: ReadonlyArray<A>,
  value: string
) => {
  const wanted = value.trim().toLowerCase()
  return entries.find(
    (entry) => entry.id.toLowerCase() === wanted || entry.name.toLowerCase() === wanted
  )
}

const findObjective = (work: RoutingToolDeps['work'], value: string) =>
  Effect.gen(function* () {
    const wanted = value.trim().toLowerCase()
    const snapshot = yield* work.snapshot
    const objective = snapshot.objectives.find((entry) => entry.id === wanted)
    if (objective === undefined) {
      return yield* new InvalidInput({ message: `No objective has id "${value}".` })
    }
    return {
      objective,
      issues: snapshot.issues.filter((issue) => issue.objectiveId === objective.id)
    }
  })

const recover =
  (tool: string) =>
  (effect: Effect.Effect<DiaToolResult, InvalidInput>): Effect.Effect<DiaToolResult> =>
    effect.pipe(
      Effect.catchTag('InvalidInput', (error) =>
        Effect.logInfo('Routing tool refused the call', { tool }).pipe(
          Effect.as(result(error.message, true))
        )
      ),
      Effect.catchCause((cause) =>
        Effect.logError('Routing tool failed', { tool }, cause).pipe(
          Effect.as(result(`The ${tool} call failed.`, true))
        )
      )
    )

const assigneeName = (issue: Issue, hires: ReadonlyArray<RoutingHire>) => {
  if (issue.assignee === null) return 'nobody'
  const { provider, id } = issue.assignee
  return (
    (provider === ORG_PROVIDER ? hires.find((hire) => hire.id === id)?.name : undefined) ?? provider
  )
}

const issueLine = (issue: Issue, hires: ReadonlyArray<RoutingHire>) => {
  const assignee = assigneeName(issue, hires)
  return `  - ${issue.kind} issue "${issue.title}": ${issue.status}, assigned to ${assignee}`
}

const objectiveLines = (
  objective: Objective,
  issues: ReadonlyArray<Issue>,
  projects: ReadonlyArray<RoutingProject>,
  hires: ReadonlyArray<RoutingHire>
) => [
  `- ${objective.id} "${objective.title}" in ${projects.find((project) => project.id === objective.projectId)?.name ?? 'a removed project'}, ${objective.priority} priority`,
  ...issues
    .filter((issue) => issue.objectiveId === objective.id)
    .map((issue) => issueLine(issue, hires))
]

const readTool = (deps: RoutingToolDeps): DiaTool =>
  diaTool({
    name: 'objectives_read',
    description:
      "List the registered projects, the hired agents, and every open objective with its issues. Call it before objective_create, so you don't create an objective that already exists.",
    input: Schema.Struct({}),
    run: () =>
      recover('objectives_read')(
        Effect.gen(function* () {
          const [projects, hires, snapshot] = yield* Effect.all([
            deps.projects,
            deps.hires,
            deps.work.snapshot
          ])
          const open = snapshot.objectives.filter((objective) => objective.state === 'open')
          const lines = [
            'Projects:',
            ...(projects.length === 0
              ? ['- none']
              : projects.map((project) => `- ${project.id} ${project.name}`)),
            'Hired agents:',
            ...(hires.length === 0
              ? ['- none']
              : hires.map((hire) => `- ${hire.id} ${hire.name} (${hire.jobTitle})`)),
            'Open objectives:',
            ...(open.length === 0
              ? ['- none']
              : open.flatMap((objective) =>
                  objectiveLines(objective, snapshot.issues, projects, hires)
                ))
          ]
          return result(lines.join('\n'))
        })
      )
  })

const decodeRoute = (deps: RoutingToolDeps, input: Input) =>
  Effect.gen(function* () {
    const route = present(input, 'route')
    const assignee = present(input, 'assignee')
    if (route === 'plan') {
      if (assignee !== undefined) {
        return yield* new InvalidInput({
          message:
            'Route plan takes no assignee: its planning issue waits for the user to assign it.'
        })
      }
      return { route: PlanRoute.make({ assignee: null }), assigneeName: undefined }
    }
    if (route !== 'direct') {
      return yield* new InvalidInput({ message: 'Invalid route: use direct or plan.' })
    }
    if (assignee === undefined) {
      return yield* new InvalidInput({ message: 'Route direct needs an assignee: a hired agent.' })
    }
    const hire = byIdOrName(yield* deps.hires, assignee)
    if (hire === undefined) {
      return yield* new InvalidInput({ message: `No hired agent is called "${assignee}".` })
    }
    return { route: DirectRoute.make({ assignee: hire.id }), assigneeName: hire.name }
  })

const decodeNote = (input: Input) =>
  Effect.gen(function* () {
    const note = present(input, 'note')?.trim()
    if (note === undefined || note === '') return undefined
    const words = note.split(/\s+/).length
    if (words > ROUTING_NOTE_MAX_WORDS) {
      return yield* new InvalidInput({
        message: `The routing note has ${words} words; keep it to ${ROUTING_NOTE_MAX_WORDS} or fewer.`
      })
    }
    return note
  })

const createTool = (deps: RoutingToolDeps): DiaTool =>
  diaTool({
    name: 'objective_create',
    description:
      "Create an objective from the user's request. Route direct gives one piece of work to one hired agent; route plan creates a planning issue that waits for the user to assign it.",
    input: Schema.Struct({
      project: required('Id or name of the registered project the work is in.'),
      title: required('Short title of the objective, up to 120 characters.'),
      request: required("The user's words, exactly as they wrote them."),
      route: required('direct or plan.'),
      assignee: optional('Id or name of the hired agent, for route direct only.'),
      note: optional(`Routing facts only, at most ${ROUTING_NOTE_MAX_WORDS} words.`),
      priority: optional('high, normal or low; normal when omitted.')
    }),
    run: (input) =>
      recover('objective_create')(
        Effect.gen(function* () {
          const projectName = present(input, 'project') ?? ''
          const project = byIdOrName(yield* deps.projects, projectName)
          if (project === undefined) {
            return yield* new InvalidInput({
              message: `No registered project is called "${projectName}".`
            })
          }
          const title = yield* decodeField(WorkTitle, 'title', (input.title ?? '').trim())
          const { route, assigneeName } = yield* decodeRoute(deps, input)
          const note = yield* decodeNote(input)
          const priority =
            (yield* decodeOptional(ObjectivePriority, 'priority', present(input, 'priority'))) ??
            'normal'
          const request = input.request ?? ''
          const description = note === undefined ? request : `${request}\n\nRouting note: ${note}`
          const assignee =
            route._tag === 'DirectRoute'
              ? AssigneeRef.make({ provider: ORG_PROVIDER, id: route.assignee })
              : null
          const firstIssue: FirstIssue =
            assignee === null
              ? { kind: 'planning', title: prefixedTitle('Plan', title), description: '', assignee }
              : {
                  kind: 'work',
                  title,
                  description: description.slice(0, ISSUE_DESCRIPTION_MAX_LENGTH),
                  assignee
                }
          const id = yield* deps.newObjectiveId
          yield* deps.claim(id)
          const created = yield* deps.work
            .createObjective(
              { id, projectId: project.id, title, description, priority, assignee },
              [firstIssue]
            )
            .pipe(
              Effect.mapError(
                (error) =>
                  new InvalidInput({
                    message:
                      error._tag === 'ProjectNotFound'
                        ? `Project "${project.name}" is no longer registered.`
                        : 'That hired agent was dismissed.'
                  })
              )
            )
          yield* Effect.logInfo('Executive assistant created an objective', {
            objectiveId: created.id,
            route: route._tag
          })
          return result(
            route._tag === 'DirectRoute'
              ? `Created objective ${created.id} "${created.title}" in ${project.name}, with one issue for ${assigneeName}.`
              : `Created objective ${created.id} "${created.title}" in ${project.name}. Its planning issue waits for the user to assign it.`
          )
        })
      )
  })

const attachTool = (deps: RoutingToolDeps): DiaTool =>
  diaTool({
    name: 'objective_attach',
    description:
      "Pass the user's message to the agents working on an existing objective. Use it only when the message names that objective, or refers to work you just started and exactly one objective fits.",
    input: Schema.Struct({
      objective: required('Id of the objective.'),
      message: required("The user's message, exactly as they wrote it.")
    }),
    run: (input) =>
      recover('objective_attach')(
        Effect.gen(function* () {
          const { issues } = yield* findObjective(deps.work, input.objective ?? '')
          const running = issues.filter((issue) => isStarted(issue.status))
          const delivered = yield* Effect.forEach(running, (issue) =>
            deps.deliver(issue.id, input.message ?? '')
          )
          const count = delivered.filter(Boolean).length
          return result(
            count === 0
              ? 'No agent is working on this objective now.'
              : `Delivered to ${count} running session${count === 1 ? '' : 's'}.`
          )
        })
      )
  })

const stopTool = (deps: RoutingToolDeps): DiaTool =>
  diaTool({
    name: 'objective_stop',
    description:
      'Stop an objective the user asked to stop: cancel its open issues and end their sessions.',
    input: Schema.Struct({ objective: required('Id of the objective.') }),
    run: (input) =>
      recover('objective_stop')(
        Effect.gen(function* () {
          const { objective } = yield* findObjective(deps.work, input.objective ?? '')
          const canceled = yield* deps.work
            .stopObjective(objective.id)
            .pipe(
              Effect.catchTag(
                'ObjectiveNotFound',
                () => new InvalidInput({ message: `No objective has id "${objective.id}".` })
              )
            )
          return result(
            canceled.length === 0
              ? `Objective "${objective.title}" had no open issues.`
              : `Stopped "${objective.title}": canceled ${canceled.map((issue) => `"${issue.title}"`).join(', ')}.`
          )
        })
      )
  })

/**
 * The Executive assistant's routing tools (ADR-0053, ADR-0071): `objectives_read`,
 * `objective_create`, `objective_attach` and `objective_stop`. A refused call returns its reason
 * with `isError` set and changes nothing. Register them with `dia-tools` for the Executive assistant's
 * run scope.
 */
export const makeRoutingTools = (deps: RoutingToolDeps): ReadonlyArray<DiaTool> => [
  readTool(deps),
  createTool(deps),
  attachTool(deps),
  stopTool(deps)
]

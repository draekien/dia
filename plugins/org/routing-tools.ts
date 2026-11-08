import type { DiaTool, DiaToolResult, ProjectId } from '@dia/plugin'
import { Effect } from 'effect'
import type { Dispatcher } from './dispatcher'
import {
  DirectRoute,
  type HireId,
  type Issue,
  type Objective,
  type ObjectiveId,
  ObjectivePriority,
  PlanRoute,
  WorkTitle
} from './domain'
import {
  decodeField,
  decodeOptional,
  type Input,
  InvalidInput,
  optional,
  present,
  required,
  result
} from './tool-input'
import type { Work } from './work'

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
 * records that the Executive assistant created an objective, before it is created.
 */
export interface RoutingToolDeps {
  readonly work: Pick<Work, 'snapshot' | 'createObjective' | 'stopObjective'>
  readonly projects: Effect.Effect<ReadonlyArray<RoutingProject>>
  readonly hires: Effect.Effect<ReadonlyArray<RoutingHire>>
  readonly newObjectiveId: Effect.Effect<ObjectiveId>
  readonly claim: (objectiveId: ObjectiveId) => Effect.Effect<void>
  readonly dispatcher: Pick<Dispatcher, 'signal' | 'message' | 'release'>
}

const STARTED = new Set([
  'understanding',
  'designing',
  'implementing',
  'testing',
  'verifying',
  'in_review'
])

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

const issueLine = (issue: Issue, hires: ReadonlyArray<RoutingHire>) => {
  const assignee = hires.find((hire) => hire.id === issue.assignee)?.name ?? 'nobody'
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

const readTool = (deps: RoutingToolDeps): DiaTool => ({
  name: 'objectives_read',
  description:
    "List the registered projects, the hired agents, and every open objective with its issues. Call it before objective_create, so you don't create an objective that already exists.",
  input: {},
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
      return PlanRoute.make({ assignee: null })
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
    return DirectRoute.make({ assignee: hire.id })
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

const createTool = (deps: RoutingToolDeps): DiaTool => ({
  name: 'objective_create',
  description:
    "Create an objective from the user's request. Route direct gives one piece of work to one hired agent; route plan creates a planning issue that waits for the user to assign it.",
  input: {
    project: required('Id or name of the registered project the work is in.'),
    title: required('Short title of the objective, up to 120 characters.'),
    request: required("The user's words, exactly as they wrote them."),
    route: required('direct or plan.'),
    assignee: optional('Id or name of the hired agent, for route direct only.'),
    note: optional(`Routing facts only, at most ${ROUTING_NOTE_MAX_WORDS} words.`),
    priority: optional('high, normal or low; normal when omitted.')
  },
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
        const route = yield* decodeRoute(deps, input)
        const note = yield* decodeNote(input)
        const priority =
          (yield* decodeOptional(ObjectivePriority, 'priority', present(input, 'priority'))) ??
          'normal'
        const request = input.request ?? ''
        const id = yield* deps.newObjectiveId
        yield* deps.claim(id)
        const created = yield* deps.work
          .createObjective({
            id,
            projectId: project.id,
            title,
            description: note === undefined ? request : `${request}\n\nRouting note: ${note}`,
            priority,
            route
          })
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
        yield* deps.dispatcher.signal
        yield* Effect.logInfo('Executive assistant created an objective', {
          objectiveId: created.id,
          route: route._tag
        })
        return result(
          route._tag === 'DirectRoute'
            ? `Created objective ${created.id} "${created.title}" in ${project.name}, with one issue for ${(yield* deps.hires).find((hire) => hire.id === route.assignee)?.name ?? 'the agent'}.`
            : `Created objective ${created.id} "${created.title}" in ${project.name}. Its planning issue waits for the user to assign it.`
        )
      })
    )
})

const attachTool = (deps: RoutingToolDeps): DiaTool => ({
  name: 'objective_attach',
  description:
    "Pass the user's message to the agents working on an existing objective. Use it only when the message names that objective, or refers to work you just started and exactly one objective fits.",
  input: {
    objective: required('Id of the objective.'),
    message: required("The user's message, exactly as they wrote it.")
  },
  run: (input) =>
    recover('objective_attach')(
      Effect.gen(function* () {
        const { issues } = yield* findObjective(deps.work, input.objective ?? '')
        const running = issues.filter((issue) => STARTED.has(issue.status))
        const delivered = yield* Effect.forEach(running, (issue) =>
          deps.dispatcher.message(issue.id, input.message ?? '')
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

const stopTool = (deps: RoutingToolDeps): DiaTool => ({
  name: 'objective_stop',
  description:
    'Stop an objective the user asked to stop: cancel its open issues and end their sessions.',
  input: { objective: required('Id of the objective.') },
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
        yield* Effect.forEach(canceled, (issue) => deps.dispatcher.release(issue.id), {
          discard: true
        })
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
 * with `isError` set and changes nothing. Build them once and pass them as the assistant session's
 * dia tools.
 */
export const makeRoutingTools = (deps: RoutingToolDeps): ReadonlyArray<DiaTool> => [
  readTool(deps),
  createTool(deps),
  attachTool(deps),
  stopTool(deps)
]

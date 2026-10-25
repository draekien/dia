import { Schema } from 'effect'
import type { IpcEvent } from '../ipc/contract'
import type { UserInputRequest } from './attention'
import { Uuid } from './uuid'

/** Activity line from the agent's current `TodoWrite` item. */
export const Todo = Schema.TaggedStruct('Todo', { text: Schema.String })
export type Todo = typeof Todo.Type

/** Activity line from the agent's last tool call; `target` is the file, command or URL it acted on. */
export const ToolUse = Schema.TaggedStruct('ToolUse', {
  tool: Schema.String,
  target: Schema.NullOr(Schema.String)
})
export type ToolUse = typeof ToolUse.Type

/** No activity line: the agent has not used a tool since dia first saw it. */
export const NoActivity = Schema.TaggedStruct('NoActivity', {})
export type NoActivity = typeof NoActivity.Type

/** The second line of an overview row when the agent neither needs input nor failed. */
export const Activity = Schema.Union([Todo, ToolUse, NoActivity])
export type Activity = typeof Activity.Type

/** The agent waits for the user; `reason` states what it asks. */
export const StatusNeedsInput = Schema.TaggedStruct('StatusNeedsInput', { reason: Schema.String })
export type StatusNeedsInput = typeof StatusNeedsInput.Type

/** The agent's session failed; `reason` is the error message. */
export const StatusFailed = Schema.TaggedStruct('StatusFailed', { reason: Schema.String })
export type StatusFailed = typeof StatusFailed.Type

/** The agent is running a turn. */
export const StatusWorking = Schema.TaggedStruct('StatusWorking', {})
export type StatusWorking = typeof StatusWorking.Type

/** The agent finished a turn the user has not seen yet. */
export const StatusFinished = Schema.TaggedStruct('StatusFinished', {})
export type StatusFinished = typeof StatusFinished.Type

/** The agent has nothing new to show. */
export const StatusIdle = Schema.TaggedStruct('StatusIdle', {})
export type StatusIdle = typeof StatusIdle.Type

/** The status an overview row shows. Order rows with {@link statusRank}. */
export const AgentStatus = Schema.Union([
  StatusNeedsInput,
  StatusFailed,
  StatusWorking,
  StatusFinished,
  StatusIdle
])
export type AgentStatus = typeof AgentStatus.Type

/** What the overview shows for one tab: its status and its activity line. */
export const AgentSummary = Schema.Struct({
  paneId: Uuid,
  status: AgentStatus,
  activity: Activity
})
export type AgentSummary = typeof AgentSummary.Type

const TARGET_FIELDS = ['file_path', 'command', 'pattern', 'url', 'path'] as const

const toolTarget = (input: Readonly<Record<string, unknown>>): string | null =>
  TARGET_FIELDS.map((field) => input[field]).find(
    (value): value is string => typeof value === 'string' && value.length > 0
  ) ?? null

const describeTarget = (target: string | null): string => (target === null ? '' : ` ${target}`)

const needsInputReason = (request: UserInputRequest): string => {
  switch (request._tag) {
    case 'PermissionRequest':
      return `Allow ${request.toolName}${describeTarget(toolTarget(request.input))}?`
    case 'ClarifyingQuestion':
      return request.questions[0]?.question ?? 'Answer the question'
    case 'PlanReview':
      return 'Review the plan'
  }
}

const todoActivity = (input: Readonly<Record<string, unknown>>): Activity => {
  const todos = Array.isArray(input.todos) ? (input.todos as ReadonlyArray<unknown>) : []
  const current = todos.find(
    (todo): todo is Record<string, unknown> =>
      typeof todo === 'object' &&
      todo !== null &&
      (todo as Record<string, unknown>).status === 'in_progress'
  )
  const text = [current?.activeForm, current?.content].find(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  return text === undefined
    ? ToolUse.make({ tool: 'TodoWrite', target: null })
    : Todo.make({ text })
}

const withActivity = (summary: AgentSummary, activity: Activity): AgentSummary =>
  summary.activity._tag === 'Todo' ? summary : { ...summary, activity }

/** A summary for a tab dia has no live events for: idle, with the last activity it saved. */
export const idleSummary = (paneId: string, activity: Activity): AgentSummary =>
  AgentSummary.make({ paneId, status: StatusIdle.make({}), activity })

/**
 * The summary after one event. Events for other panes, and events that change neither status nor
 * activity, return `summary` unchanged.
 */
export const foldSummary = (summary: AgentSummary, event: IpcEvent): AgentSummary => {
  if (!('paneId' in event) || event.paneId !== summary.paneId) return summary
  switch (event._tag) {
    case 'PaneUserMessagesSent':
      return { ...summary, status: StatusWorking.make({}) }
    case 'PaneToolCallStarted':
      return withActivity(summary, ToolUse.make({ tool: event.toolName, target: null }))
    case 'PaneToolCallCompleted':
      return event.toolName === 'TodoWrite'
        ? { ...summary, activity: todoActivity(event.input) }
        : withActivity(
            summary,
            ToolUse.make({ tool: event.toolName, target: toolTarget(event.input) })
          )
    case 'PaneAttentionChanged': {
      const attention = event.attention
      switch (attention._tag) {
        case 'AwaitingPermission':
          return {
            ...summary,
            status: StatusNeedsInput.make({ reason: needsInputReason(attention.request) })
          }
        case 'Idle':
          return summary.status._tag === 'StatusNeedsInput'
            ? { ...summary, status: StatusWorking.make({}) }
            : summary
        case 'Completed':
          return { ...summary, status: StatusFinished.make({}) }
        case 'Errored':
        case 'Crashed':
          return { ...summary, status: StatusFailed.make({ reason: attention.error.message }) }
      }
      return summary
    }
    default:
      return summary
  }
}

/** The summary once the user has shown the tab: finished becomes idle; other statuses stay. */
export const markShown = (summary: AgentSummary): AgentSummary =>
  summary.status._tag === 'StatusFinished' ? { ...summary, status: StatusIdle.make({}) } : summary

const STATUS_RANK: Record<AgentStatus['_tag'], number> = {
  StatusNeedsInput: 0,
  StatusFailed: 1,
  StatusWorking: 2,
  StatusFinished: 3,
  StatusIdle: 4
}

/**
 * The overview order of a status: needs input 0, failed 1, working 2, finished 3, idle 4. A lower
 * rank is more urgent.
 */
export const statusRank = (status: AgentStatus): number => STATUS_RANK[status._tag]

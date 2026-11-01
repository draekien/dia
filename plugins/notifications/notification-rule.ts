import type { AgentStatus, AgentSummary } from '@shared/domain/agent-summary'
import type { AgentNotification } from '@shared/domain/notification'
import type { Workspace } from '@shared/domain/project'
import { Equal } from 'effect'

/**
 * What the notification rule knows: the latest workspace (`null` until the first arrives),
 * whether the user can see dia's window, and the last status seen for each agent.
 */
export interface RuleState {
  readonly workspace: Workspace | null
  readonly attended: boolean
  readonly statuses: ReadonlyMap<string, AgentStatus>
}

/** The rule's state before anything has been observed: no workspace, window attended. */
export const INITIAL_RULE_STATE: RuleState = {
  workspace: null,
  attended: true,
  statuses: new Map()
}

/** One observation applied to the rule: the next state and the notifications to show now. */
export type RuleStep = (state: RuleState) => readonly [RuleState, ReadonlyArray<AgentNotification>]

/** The step for a new workspace: it names the agents and the visible tab. Shows nothing. */
export const workspaceChanged =
  (workspace: Workspace): RuleStep =>
  (state) => [{ ...state, workspace }, []]

/** The step for a change in whether the user can see dia's window. Shows nothing. */
export const attentionChanged =
  (attended: boolean): RuleStep =>
  (state) => [{ ...state, attended }, []]

const reasonOf = (status: AgentStatus): string | undefined => {
  switch (status._tag) {
    case 'StatusNeedsInput':
      return `Needs input: ${status.reason}`
    case 'StatusFailed':
      return `Failed: ${status.reason}`
    default:
      return undefined
  }
}

const agentTitle = (workspace: Workspace, paneId: string): string | undefined => {
  for (const entry of workspace.projects) {
    const tab = entry.tabs.find((candidate) => candidate.config.paneId === paneId)
    if (tab !== undefined) return `${tab.name} in ${entry.project.displayName}`
  }
  return undefined
}

const isOnScreen = (state: RuleState, paneId: string): boolean =>
  state.attended && state.workspace?.visibleTab === paneId

/**
 * The step for an agent's new summary. It shows one notification when the agent's status changed
 * into one that needs the user (needs input or failed), the agent has a tab, and that tab is not
 * on screen: not the visible tab, or the window is minimised, hidden or not focused. The title
 * names the agent and its project; the body names the reason.
 */
export const summaryChanged =
  (summary: AgentSummary): RuleStep =>
  (state) => {
    const previous = state.statuses.get(summary.paneId)
    const next: RuleState = {
      ...state,
      statuses: new Map(state.statuses).set(summary.paneId, summary.status)
    }
    const reason = reasonOf(summary.status)
    if (
      reason === undefined ||
      (previous !== undefined && Equal.equals(previous, summary.status))
    ) {
      return [next, []]
    }
    const title = state.workspace === null ? undefined : agentTitle(state.workspace, summary.paneId)
    if (title === undefined || isOnScreen(state, summary.paneId)) return [next, []]
    return [next, [{ paneId: summary.paneId, title, body: reason }]]
  }

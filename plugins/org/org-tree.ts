import { descendantsOf, type HiredAgent, type HireId } from './domain'

/** One agent in the org chart and the agents that report to it, ordered by `hiredAt`. */
export interface OrgNode {
  readonly agent: HiredAgent
  readonly reports: ReadonlyArray<OrgNode>
}

const byHiredAt = (agents: ReadonlyArray<HiredAgent>): ReadonlyArray<HiredAgent> =>
  [...agents].sort((a, b) => a.hiredAt - b.hiredAt)

/**
 * The org chart of `hiredAgents`: the nodes that report to the user, each holding its reports.
 * An agent whose `reportsTo` names no agent in `hiredAgents` is shown as reporting to the user.
 * Agents with equal `hiredAt` keep their order in `hiredAgents`.
 */
export const orgTree = (hiredAgents: ReadonlyArray<HiredAgent>): ReadonlyArray<OrgNode> => {
  const ids = new Set(hiredAgents.map((agent) => agent.id))
  const nodeOf = (agent: HiredAgent): OrgNode => ({
    agent,
    reports: byHiredAt(hiredAgents.filter((other) => other.reportsTo === agent.id)).map(nodeOf)
  })
  const roots = hiredAgents.filter((agent) => agent.reportsTo === null || !ids.has(agent.reportsTo))
  return byHiredAt(roots).map(nodeOf)
}

/**
 * The agents `hireId` may report to: every agent in `hiredAgents` except `hireId` and the agents
 * below it, in snapshot order. The org refuses any other choice with `ReportsToCycle`.
 */
export const reportsToChoices = (
  hiredAgents: ReadonlyArray<HiredAgent>,
  hireId: HireId
): ReadonlyArray<HiredAgent> => {
  const below = descendantsOf(hiredAgents, hireId)
  return hiredAgents.filter((agent) => agent.id !== hireId && !below.has(agent.id))
}

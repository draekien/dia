import { type IssueId, type ObjectivePriority, PRIORITY_RANK } from '@dia-plugin/issues/domain'
import type { HireId, OverallCap } from './domain'

/** A waiting issue the scheduler may start: its assignee, its objective's priority and its age. */
export interface StartCandidate {
  readonly issueId: IssueId
  readonly hireId: HireId
  readonly priority: ObjectivePriority
  readonly createdAt: number
}

/**
 * What one scheduling pass sees. `heldSlots` is how many slots of the overall cap are held now.
 * `busyHires` are the hired agents with a started issue. `answered` are issues whose permission
 * answers wait to be resolved, each once, oldest answer first.
 */
export interface SchedulerInput {
  readonly overallCap: OverallCap
  readonly heldSlots: number
  readonly busyHires: ReadonlySet<HireId>
  readonly answered: ReadonlyArray<IssueId>
  readonly waiting: ReadonlyArray<StartCandidate>
}

/** The issues a pass resumes and the issues it starts, each in the order to act on them. */
export interface SchedulerPick {
  readonly resume: ReadonlyArray<IssueId>
  readonly start: ReadonlyArray<IssueId>
}

const byStartOrder = (left: StartCandidate, right: StartCandidate): number =>
  PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
  left.createdAt - right.createdAt ||
  (left.issueId < right.issueId ? -1 : left.issueId > right.issueId ? 1 : 0)

/**
 * Picks what one scheduling pass does (ADR-0033, "Scheduling"). Answered issues resume first, in
 * order, while the held slots stay within one over the overall cap. Then `todo` issues start by
 * objective priority (`high` first), then oldest first, then by id, at most one per hired agent
 * and none for a busy one, while the held slots stay within the overall cap. A job title's cap,
 * its number of hired agents, holds because a hired agent runs one issue at a time. Pure.
 */
export const nextStarts = (input: SchedulerInput): SchedulerPick => {
  const resume = input.answered.slice(0, Math.max(0, input.overallCap + 1 - input.heldSlots))
  const free = input.overallCap - input.heldSlots - resume.length
  const hires = new Set(input.busyHires)
  const start: Array<IssueId> = []
  for (const candidate of [...input.waiting].sort(byStartOrder)) {
    if (start.length >= free) break
    if (hires.has(candidate.hireId)) continue
    hires.add(candidate.hireId)
    start.push(candidate.issueId)
  }
  return { resume, start }
}

import type { HireId, ObjectivePriority, OverallCap, TaskId } from './domain'

/** A waiting task the scheduler may start: its assignee, its objective's priority and its age. */
export interface StartCandidate {
  readonly taskId: TaskId
  readonly hireId: HireId
  readonly priority: ObjectivePriority
  readonly createdAt: number
}

/**
 * What one scheduling pass sees. `heldSlots` is how many slots of the overall cap are held now.
 * `busyHires` are the hired agents with a running task. `answered` are tasks whose permission
 * answers wait to be resolved, each once, oldest answer first.
 */
export interface SchedulerInput {
  readonly overallCap: OverallCap
  readonly heldSlots: number
  readonly busyHires: ReadonlySet<HireId>
  readonly answered: ReadonlyArray<TaskId>
  readonly waiting: ReadonlyArray<StartCandidate>
}

/** The tasks a pass resumes and the tasks it starts, each in the order to act on them. */
export interface SchedulerPick {
  readonly resume: ReadonlyArray<TaskId>
  readonly start: ReadonlyArray<TaskId>
}

const PRIORITY_RANK: Record<ObjectivePriority, number> = { high: 0, normal: 1, low: 2 }

const byStartOrder = (left: StartCandidate, right: StartCandidate): number =>
  PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
  left.createdAt - right.createdAt ||
  (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0)

/**
 * Picks what one scheduling pass does (ADR-0033, "Scheduling"). Answered tasks resume first, in
 * order, while the held slots stay within one over the overall cap. Then waiting tasks start by
 * objective priority (`high` first), then oldest first, then by id, at most one per hired agent
 * and none for a busy one, while the held slots stay within the overall cap. A job title's cap,
 * its number of hired agents, holds because a hired agent runs one task at a time. Pure.
 */
export const nextStarts = (input: SchedulerInput): SchedulerPick => {
  const resume = input.answered.slice(0, Math.max(0, input.overallCap + 1 - input.heldSlots))
  const free = input.overallCap - input.heldSlots - resume.length
  const hires = new Set(input.busyHires)
  const start: Array<TaskId> = []
  for (const candidate of [...input.waiting].sort(byStartOrder)) {
    if (start.length >= free) break
    if (hires.has(candidate.hireId)) continue
    hires.add(candidate.hireId)
    start.push(candidate.taskId)
  }
  return { resume, start }
}

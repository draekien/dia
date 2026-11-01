import { Schema } from 'effect'

/**
 * Work an agent started that keeps running outside its turn, such as a background shell command
 * or subagent: `taskId` identifies it within its session and `description` is the agent's one-line
 * description of it. A session reports the full set of its running tasks each time the set changes.
 */
export const BackgroundTask = Schema.Struct({
  taskId: Schema.String,
  description: Schema.String
})
export type BackgroundTask = typeof BackgroundTask.Type

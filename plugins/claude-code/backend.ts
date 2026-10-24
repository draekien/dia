import type { AgentBackend } from '@dia/plugin'
import { openClaudeCodeSession } from './session'
import { readHistory } from './transcript'

/**
 * The {@link AgentBackend} that drives the local Claude Code install through the Agent SDK.
 * It holds no state of its own; each session it opens lives in the scope it is opened in.
 */
export const makeClaudeCodeBackend = (): AgentBackend => ({
  openSession: openClaudeCodeSession,
  readHistory
})

import type { AgentBackend } from '@dia/plugin'
import { deleteSession } from './delete-session'
import { openClaudeCodeSession } from './session'
import { readHistory } from './transcript'

/**
 * The {@link AgentBackend} that drives the local Claude Code install through the Agent SDK.
 * Each session it opens lives in the scope it is opened in; `catalog` is the model list from
 * `makeModelCatalog`, the only state the backend exposes.
 */
export const makeClaudeCodeBackend = (
  catalog: Pick<AgentBackend, 'models' | 'refreshModels'>
): AgentBackend => ({
  openSession: openClaudeCodeSession,
  readHistory,
  deleteSession,
  models: catalog.models,
  refreshModels: catalog.refreshModels
})

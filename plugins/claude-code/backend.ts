import type { AgentBackend } from '@dia/plugin'
import { Effect } from 'effect'
import type { ClaudeInstall } from './claude-install'
import { deleteSession } from './delete-session'
import type { ClaudeHealth } from './health'
import { readDisabledPermissionModes } from './permission-settings'
import { openClaudeCodeSession } from './session'
import { readHistory } from './transcript'

/**
 * The {@link AgentBackend} that drives the user's Claude Code install through the Agent SDK.
 * Each session it opens lives in the scope it is opened in and runs the path `install` resolves
 * at that moment. `catalog` is the model list from `makeModelCatalog`; `health` is the install's
 * health from `makeClaudeHealth`, built over the same `install`.
 */
export const makeClaudeCodeBackend = (deps: {
  readonly catalog: Pick<AgentBackend, 'models' | 'refreshModels'>
  readonly install: ClaudeInstall
  readonly health: ClaudeHealth
}): AgentBackend => ({
  openSession: (options) =>
    openClaudeCodeSession(options, deps.install, deps.health.reportStartupFailure),
  readHistory,
  deleteSession,
  models: deps.catalog.models,
  refreshModels: deps.catalog.refreshModels,
  status: deps.health.status,
  checkHealth: () => deps.health.check,
  setInstallPath: (path) =>
    deps.install.setOverride(path).pipe(Effect.andThen(deps.health.recheck)),
  disabledPermissionModes: readDisabledPermissionModes
})

export { PlanReviewResponse, Question } from '../shared/domain/attention'
export { SessionId } from '../shared/domain/pane'
export * from '../shared/plugin/api'
export {
  GIT_OPS_KEY,
  type GitOps,
  type GitOpsFactory,
  WorktreeCreateError,
  WorktreeReattachError,
  WorktreeRemoveError
} from './services/git-ops-seam'
export {
  AGENT_BACKEND_KEY,
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  ToolGate
} from './session/agent-backend'
export type { DiaTool, DiaToolField, DiaToolResult } from './session/dia-tools'
export {
  PENDING_USER_INPUT_KEY,
  type PendingUserInput,
  Superseded,
  type UserInputResolution
} from './session/pending-user-input-resolver'
export * from './session/protocol'

export {
  AdapterStatus,
  HealthError,
  HealthNotChecked,
  HealthNotInstalled,
  HealthNotSignedIn,
  HealthReady,
  HealthUnknown
} from '../shared/domain/adapter-status'
export * as AgentEvents from '../shared/domain/agent-event'
export { AGENT_NAME_ADJECTIVES, AGENT_NAME_NOUNS } from '../shared/domain/agent-name'
export { ContentAttachment, PathAttachment } from '../shared/domain/attachment'
export { PlanReviewResponse, Question } from '../shared/domain/attention'
export { OutgoingMessage } from '../shared/domain/message-queue'
export {
  MetaRepoFailed,
  MetaRepoPushed,
  MetaRepoPushRefused,
  type MetaRepoPushResult,
  MetaRepoState,
  type MetaRepoStateResult,
  SecretFinding
} from '../shared/domain/meta-repo'
export {
  type ModelCatalogState,
  ModelOption,
  ModelsLoading,
  ModelsReady,
  ModelsUnavailable
} from '../shared/domain/model'
export {
  BuiltInRoleDeleted,
  BuiltInRoleRenamed,
  HiredAgent,
  HireId,
  HireNameTaken,
  HireNotFound,
  OrgSettings,
  OverallCap,
  Role,
  RoleDisabled,
  RoleHasHires,
  RoleId,
  RoleName,
  RoleNameTaken,
  RoleNotFound
} from '../shared/domain/org'
export { SessionId } from '../shared/domain/pane'
export { ParkCause, RESUME_TEXT, SignedOut, UsageLimit } from '../shared/domain/parking'
export type { RoleSessionOptions } from '../shared/domain/role-session'
export * from '../shared/plugin/api'
export type { MetaRepo } from './services/meta-repo-seam'
export type { Org } from './services/org-seam'
export {
  type GitOps,
  type IncludedFileFailure,
  WorktreeCreateError,
  WorktreeIncludeError,
  WorktreeReattachError,
  WorktreeRemoveError
} from './services/worktrees-seam'
export {
  AGENT_BACKEND_KEY,
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  type DiscoveredSession,
  type SessionAdditions,
  type SessionEnd,
  SessionFailed,
  SessionNotFound,
  type TranscriptEntry,
  type TranscriptInfo,
  type TranscriptTail
} from './session/agent-backend'
export type { DiaTool, DiaToolField, DiaToolResult } from './session/dia-tools'
export {
  makePendingUserInput,
  type PendingUserInput,
  Superseded,
  type UserInputResolution
} from './session/pending-user-input'
export * from './session/protocol'

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
export { AttachedSession } from '../shared/domain/attached-session'
export { ContentAttachment, PathAttachment } from '../shared/domain/attachment'
export { PermissionResponse, PlanReviewResponse, Question } from '../shared/domain/attention'
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
export { type PaneId, SessionId, ThinkingLevel } from '../shared/domain/pane'
export { ParkCause, RESUME_TEXT, SignedOut, UsageLimit } from '../shared/domain/parking'
export { AgentName, ProjectId } from '../shared/domain/project'
export { PermissionRules, type SessionToolOptions } from '../shared/domain/session-tools'
export { Uuid } from '../shared/domain/uuid'
export * from '../shared/plugin/api'
export * from '../shared/plugin/list-slot'
export { PluginCallInvalid, PluginNotServing } from '../shared/plugin/messages'
export type {
  HostPluginContext,
  HostSessions,
  SessionAttachment
} from './plugins/host-plugin-context'
export { type MetaRepo, MetaRepoKey } from './services/meta-repo-seam'
export {
  type GitOps,
  type IncludedFileFailure,
  WorktreeCreateError,
  WorktreeIncludeError,
  WorktreeReattachError,
  WorktreeRemoveError,
  WorktreesKey
} from './services/worktrees-seam'
export {
  type AgentBackend,
  AgentBackendKey,
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
export { type HiredStartMode, startPermissionMode } from './session/start-permission-mode'

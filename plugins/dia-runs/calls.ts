import {
  Attachment,
  ModelPreferences,
  Parking,
  PermissionMode,
  PermissionResponse,
  QuestionResponse,
  SendMode,
  SlashCommandInfo,
  ThinkingLevel
} from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/**
 * Sends a user message to run `runId`, opening the run when it is not live. This call and every
 * other call here that changes a run applies once per call id: a resent call applies nothing.
 */
export const SendMessage = Rpc.make('SendMessage', {
  payload: {
    runId: Schema.String,
    text: Schema.String,
    mode: SendMode,
    attachments: Schema.optional(Schema.Array(Attachment))
  }
})

/** Replaces the text (and attachments, when given) of a queued message of run `runId`. */
export const EditQueuedMessage = Rpc.make('EditQueuedMessage', {
  payload: {
    runId: Schema.String,
    messageId: Schema.String,
    text: Schema.String,
    attachments: Schema.optional(Schema.Array(Attachment))
  }
})

/** Removes a queued message of run `runId`. */
export const RemoveQueuedMessage = Rpc.make('RemoveQueuedMessage', {
  payload: { runId: Schema.String, messageId: Schema.String }
})

/** Sends a queued message of run `runId` now, interrupting a running turn. */
export const SendQueuedMessageNow = Rpc.make('SendQueuedMessageNow', {
  payload: { runId: Schema.String, messageId: Schema.String }
})

/** Answers permission request `requestId` of run `runId`. */
export const ResolvePermission = Rpc.make('ResolvePermission', {
  payload: { runId: Schema.String, requestId: Schema.String, response: PermissionResponse }
})

/** Answers clarifying question `requestId` of run `runId`. */
export const ResolveQuestion = Rpc.make('ResolveQuestion', {
  payload: { runId: Schema.String, requestId: Schema.String, response: QuestionResponse }
})

/** Approves or rejects plan review `requestId` of run `runId`. */
export const ResolvePlanReview = Rpc.make('ResolvePlanReview', {
  payload: { runId: Schema.String, requestId: Schema.String, approved: Schema.Boolean }
})

/** Interrupts run `runId`'s turn. */
export const InterruptRun = Rpc.make('InterruptRun', { payload: { runId: Schema.String } })

/** Resumes run `runId` when a usage limit parked it. */
export const ResumeParkedRun = Rpc.make('ResumeParkedRun', { payload: { runId: Schema.String } })

/** Rewinds run `runId` to user message `messageUuid`, opening the run when it is not live. */
export const RewindToCheckpoint = Rpc.make('RewindToCheckpoint', {
  payload: {
    runId: Schema.String,
    messageUuid: Schema.String,
    resumeAnchorUuid: Schema.optional(Schema.String)
  }
})

/** Starts a run on adapter `backend` with no tab in `cwd`, sends it `text`, and returns its id. */
export const StartRun = Rpc.make('StartRun', {
  payload: {
    cwd: Schema.String,
    model: Schema.String,
    backend: Schema.NonEmptyString,
    thinkingLevel: ThinkingLevel,
    permissionMode: PermissionMode,
    text: Schema.String
  },
  success: Schema.String
})

/** Shows run `runId` in a tab. Returns false when no run has that id. */
export const OpenRunInTab = Rpc.make('OpenRunInTab', {
  payload: { runId: Schema.String },
  success: Schema.Boolean
})

/** What dia does when a usage limit resets. */
export const GetUsageLimitResume = Rpc.make('GetUsageLimitResume', {
  payload: {},
  success: Parking.UsageLimitResume
})

/** Stores what dia does when a usage limit resets and applies it to every parked run. */
export const SetUsageLimitResume = Rpc.make('SetUsageLimitResume', {
  payload: { mode: Parking.UsageLimitResume }
})

/** The model preferences and new-agent defaults. */
export const GetModelPreferences = Rpc.make('GetModelPreferences', {
  payload: {},
  success: ModelPreferences.ModelPreferencesSnapshot
})

/** Marks a model of adapter `adapter` favourite or hidden, or clears it with null. */
export const SetModelPreference = Rpc.make('SetModelPreference', {
  payload: {
    adapter: Schema.NonEmptyString,
    model: Schema.NonEmptyString,
    preference: Schema.NullOr(ModelPreferences.ModelPreference)
  },
  error: ModelPreferences.LastVisibleModel
})

/** Stores the defaults a new agent starts with. */
export const SetAgentDefaults = Rpc.make('SetAgentDefaults', {
  payload: { defaults: ModelPreferences.AgentDefaults }
})

/** The model preferences now and after each change. */
export const FollowModelPreferences = Rpc.make('FollowModelPreferences', {
  payload: {},
  success: ModelPreferences.ModelPreferencesSnapshot,
  stream: true
})

/** The slash commands a new session of adapter `adapter` in `cwd` would offer, with the meta repo's plugins loaded. */
export const GetSlashCommands = Rpc.make('GetSlashCommands', {
  payload: { adapter: Schema.NonEmptyString, cwd: Schema.String },
  success: Schema.Array(SlashCommandInfo)
})

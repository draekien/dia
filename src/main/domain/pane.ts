import { Schema } from 'effect'

export const ConversationMessage = Schema.Struct({
  role: Schema.Literal('user', 'assistant'),
  content: Schema.String
})
export type ConversationMessage = typeof ConversationMessage.Type

export const PaneConfig = Schema.Struct({
  paneId: Schema.UUID,
  cwd: Schema.String,
  model: Schema.String
})
export type PaneConfig = typeof PaneConfig.Type

export const PaneRecord = Schema.Struct({
  config: PaneConfig,
  history: Schema.Array(ConversationMessage)
})
export type PaneRecord = typeof PaneRecord.Type

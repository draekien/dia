import { Schema } from 'effect'
import { ConversationMessage, PaneConfig } from '../domain/pane'

export const InitMessage = Schema.TaggedStruct('Init', { config: PaneConfig })
export const SendText = Schema.TaggedStruct('SendText', { text: Schema.String })
export const InboundMessage = Schema.Union(InitMessage, SendText)
export type InboundMessage = typeof InboundMessage.Type

export const AssistantMessageReceived = Schema.TaggedStruct('AssistantMessageReceived', {
  message: ConversationMessage
})
export type OutboundMessage = typeof AssistantMessageReceived.Type

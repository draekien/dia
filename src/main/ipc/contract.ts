import { Schema } from 'effect'
import { ConversationMessage } from '../domain/pane'

export const CHANNEL = {
  command: 'dia:command',
  event: 'dia:event'
} as const

export const SendMessage = Schema.TaggedStruct('SendMessage', {
  paneId: Schema.UUID,
  text: Schema.String
})
export type SendMessage = typeof SendMessage.Type

// Additional commands (SplitPane, ClosePane, ResolvePermission, FocusPane) join this
// union in later bullets — only SendMessage is implemented for Bullet 01.
export const IpcCommand = Schema.Union(SendMessage)
export type IpcCommand = typeof IpcCommand.Type

export const PaneMessageAppended = Schema.TaggedStruct('PaneMessageAppended', {
  paneId: Schema.UUID,
  message: ConversationMessage
})
export type PaneMessageAppended = typeof PaneMessageAppended.Type

// Additional events (LayoutChanged, PaneAttentionChanged, PaneClosed) join this
// union in later bullets — only PaneMessageAppended is implemented for Bullet 01.
export const IpcEvent = Schema.Union(PaneMessageAppended)
export type IpcEvent = typeof IpcEvent.Type

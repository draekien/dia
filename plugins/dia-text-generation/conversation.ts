import type { PaneChat } from '@dia/plugin'

/** How many characters of a conversation a title call receives: the last ones. */
export const CONVERSATION_MAX_CHARACTERS = 8000

/**
 * The user and assistant text of `messages`, in order, one `User: …` or `Assistant: …` line per
 * message with text, cut to its last {@link CONVERSATION_MAX_CHARACTERS} characters. Notices,
 * errors, thinking and tool calls are left out. Empty when no message has text.
 */
export const conversationText = (messages: ReadonlyArray<PaneChat.PaneMessage>): string =>
  messages
    .flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return []
      const text = message.parts
        .flatMap((part) => (part.type === 'text' ? [part.content] : []))
        .join('\n')
        .trim()
      if (text.length === 0) return []
      return [`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`]
    })
    .join('\n')
    .slice(-CONVERSATION_MAX_CHARACTERS)

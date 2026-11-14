import type { PaneMessage } from '@shared/domain/pane-chat'

/**
 * Where each turn of a transcript ends: the id of a turn's last message, mapped to the ids of the
 * consecutive user messages that open the turn. A turn runs from those user messages up to the
 * next user message. Messages before the first user message belong to no turn.
 */
export const turnEnds = (
  messages: ReadonlyArray<Pick<PaneMessage, 'id' | 'role'>>
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const ends = new Map<string, ReadonlyArray<string>>()
  let opening: Array<string> = []
  let lastId: string | undefined
  let replied = false
  const close = () => {
    if (lastId !== undefined && opening.length > 0) ends.set(lastId, opening)
  }
  for (const message of messages) {
    if (message.role === 'user') {
      if (replied) {
        close()
        opening = []
        replied = false
      }
      opening.push(message.id)
    } else {
      replied = true
    }
    lastId = message.id
  }
  close()
  return ends
}

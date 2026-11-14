import type { PaneMessage } from '@shared/domain/pane-chat'

/**
 * Where each turn of a transcript ends: the id of a turn's last reply or error, or of its last
 * user message while it has none, mapped to the ids of the consecutive user messages that open
 * the turn. A turn runs from those user messages up to the next user message that follows a
 * reply. Notices belong to no turn and never end one, so a model change or compaction notice
 * before the next message, and a park notice, leave the previous turn's end where it was.
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
    if (message.role === 'notice') continue
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

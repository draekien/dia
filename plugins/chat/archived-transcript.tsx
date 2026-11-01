import { emptyPaneChatState, paneChatAtom, useTranscriptWidth } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { AsyncResult } from 'effect/reactivity'
import { MessageView, transcriptColumn } from './pane'
import { TranscriptItem, TranscriptScroller } from './transcript-scroller'

/**
 * The transcript of the archived agent in tab `paneId`, read-only: its current session's messages
 * with no composer, settings or rewind, above a caption that says the agent is archived. Showing
 * it starts no session. `cwd` is the tab's working directory, for attachment paths.
 */
export function ArchivedTranscript({
  paneId,
  cwd
}: {
  readonly paneId: string
  readonly cwd: string
}): React.JSX.Element {
  const [width] = useTranscriptWidth()
  const loaded = useAtomValue(paneChatAtom(paneId))
  const chat = AsyncResult.getOrElse(loaded, () => emptyPaneChatState)
  const empty = AsyncResult.isSuccess(loaded) && chat.messages.length === 0
  return (
    <div className="flex h-full flex-col bg-background text-ink">
      <TranscriptScroller
        contentClassName={transcriptColumn({ width })}
        overlay={
          <p className="border-t border-border py-3 text-center text-xs text-ink-muted">
            {empty
              ? 'This agent is archived. Claude Code holds no transcript for its session.'
              : 'This agent is archived. Its transcript is read-only.'}
          </p>
        }
      >
        {chat.messages.map((message) => (
          <TranscriptItem key={message.id} anchor={message.role === 'user'}>
            <MessageView message={message} cwd={cwd} />
          </TranscriptItem>
        ))}
      </TranscriptScroller>
    </div>
  )
}

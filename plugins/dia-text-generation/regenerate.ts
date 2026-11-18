import type { AgentName, PaneChat, TabNotFoundError } from '@dia/plugin'
import { Effect } from 'effect'
import { TitleNotGenerated } from './calls'
import { conversationText } from './conversation'
import type { TitleWriter } from './writer'

/** What {@link regenerateTitle} reads and writes; each member is a seam to the Host. */
export interface RegenerateDeps {
  /** The chat state of a run, as `RunEvents.snapshot` returns it. */
  readonly snapshot: (runId: string) => Effect.Effect<PaneChat.PaneChatSnapshot>
  readonly writer: TitleWriter
  /** Renames a tab, as `ctx.renameTab` does. */
  readonly rename: (paneId: string, name: AgentName) => Effect.Effect<void, TabNotFoundError>
}

/**
 * Titles thread `paneId` from its conversation so far, whatever its current name, and renames its
 * tab. Fails with `TitleNotGenerated` when no title is written, when the conversation holds no
 * text, or when no tab has that id; the name is then left as it was.
 */
export const regenerateTitle = Effect.fnUntraced(function* (
  deps: RegenerateDeps,
  paneId: string
): Effect.fn.Return<void, TitleNotGenerated> {
  const { state } = yield* deps.snapshot(paneId)
  const conversation = conversationText(state.messages)
  if (conversation.length === 0) {
    return yield* new TitleNotGenerated({ reason: `Thread ${paneId} has no conversation text yet` })
  }
  const name = yield* deps.writer.title(conversation)
  yield* deps
    .rename(paneId, name)
    .pipe(
      Effect.catchTag('TabNotFoundError', () =>
        Effect.fail(new TitleNotGenerated({ reason: `Thread ${paneId} has no tab` }))
      )
    )
  yield* Effect.logInfo('Regenerated a thread title', { paneId, name })
})

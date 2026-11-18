import { Effect } from 'effect'
import { TitleNotGenerated } from './calls'
import { conversationText } from './conversation'
import type { TitleDeps } from './titling'

/**
 * Titles thread `paneId` from its conversation so far, whatever its current name, and renames its
 * tab. Fails with `TitleNotGenerated` when no title is written, when the conversation holds no
 * text, or when no tab has that id; the name is then left as it was.
 */
export const regenerateTitle = Effect.fnUntraced(function* (
  deps: TitleDeps,
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

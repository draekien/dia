import { emptyPaneChatState, type PaneChatState, paneChatAtom } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import type { PaneId } from '@shared/domain/pane'
import { AsyncResult } from 'effect/reactivity'

/** The chat state of pane `paneId`, or the empty state until it loads. */
export function usePaneChat(paneId: PaneId): PaneChatState {
  return AsyncResult.getOrElse(useAtomValue(paneChatAtom(paneId)), () => emptyPaneChatState)
}

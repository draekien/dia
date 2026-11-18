import type { AgentName, PaneChat, TabNotFoundError } from '@dia/plugin'
import type { Effect } from 'effect'
import type { TitleWriter } from './writer'

/** What titling a thread reads and writes; each member is a seam to the Host. */
export interface TitleDeps {
  /** The chat state of a run, as `RunEvents.snapshot` returns it. */
  readonly snapshot: (runId: string) => Effect.Effect<PaneChat.PaneChatSnapshot>
  readonly writer: TitleWriter
  /** Renames a tab, as `ctx.renameTab` does. */
  readonly rename: (paneId: string, name: AgentName) => Effect.Effect<void, TabNotFoundError>
}

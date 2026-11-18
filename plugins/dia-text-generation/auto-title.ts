import type { HostPluginContext } from '@dia/plugin'
import {
  type AgentName,
  type CommittedEvent,
  isGeneratedAgentName,
  type PaneChat,
  type TabNotFoundError,
  tabOf
} from '@dia/plugin'
import { Effect, Option, Ref, Result, type Scope, Stream } from 'effect'
import { conversationText } from './conversation'
import type { TitleWriter } from './writer'

type Workspace = Stream.Success<HostPluginContext['workspace']>

/** What {@link startAutoTitle} reads and writes; each member is a seam to the Host. */
export interface AutoTitleDeps {
  /** Subscribes to the events committed from now on, as `RunEvents.subscribe` does. */
  readonly events: Effect.Effect<Stream.Stream<CommittedEvent>, never, Scope.Scope>
  /** The chat state of a run, as `RunEvents.snapshot` returns it. */
  readonly snapshot: (runId: string) => Effect.Effect<PaneChat.PaneChatSnapshot>
  /** The workspace now and after each change, as `ctx.workspace` streams it. */
  readonly workspace: Stream.Stream<Workspace>
  readonly writer: TitleWriter
  /** Renames a tab, as `ctx.renameTab` does. */
  readonly rename: (paneId: string, name: AgentName) => Effect.Effect<void, TabNotFoundError>
}

const skip = (runId: string, reason: string) =>
  Effect.logDebug('Skipped titling a thread', { runId, reason })

/**
 * Starts titling threads automatically in the calling scope: after the first user message of a
 * thread whose tab has a generated name and no owner, it asks the writer for a title and renames
 * the tab. Each run is decided once per process, so a repeated `MessageUpdated` of the same
 * message does nothing. Each run is titled in its own fiber. Never fails; failures are logged.
 */
export const startAutoTitle = Effect.fnUntraced(function* (
  deps: AutoTitleDeps
): Effect.fn.Return<void, never, Scope.Scope> {
  const scope = yield* Effect.scope
  const workspace = yield* Ref.make(Option.none<Workspace>())
  const decided = yield* Ref.make(new Set<string>())
  const committed = yield* deps.events

  yield* deps.workspace.pipe(
    Stream.runForEach((latest) => Ref.set(workspace, Option.some(latest))),
    Effect.forkScoped
  )

  const claim = (runId: string) =>
    Ref.modify(decided, (known) =>
      known.has(runId) ? [false, known] : [true, new Set(known).add(runId)]
    )

  const titleRun = Effect.fnUntraced(function* (runId: string) {
    const { state } = yield* deps.snapshot(runId)
    if (state.messages.filter((message) => message.role === 'user').length > 1) {
      return yield* skip(runId, 'the thread holds more than one user message')
    }
    const latest = yield* Ref.get(workspace)
    if (Option.isNone(latest)) return yield* skip(runId, 'the workspace is not known yet')
    const found = tabOf(latest.value, runId)
    if (Result.isFailure(found)) return yield* skip(runId, 'the thread has no tab')
    const { tab } = found.success
    if (tab.owner !== undefined) return yield* skip(runId, `the tab is owned by ${tab.owner}`)
    if (!isGeneratedAgentName(tab.name)) return yield* skip(runId, 'the tab has a typed name')
    const conversation = conversationText(state.messages)
    if (conversation.length === 0) return yield* skip(runId, 'the thread has no text yet')
    const name = yield* deps.writer.title(conversation)
    yield* deps.rename(runId, name)
    yield* Effect.logInfo('Titled a thread', { runId, from: tab.name, to: name })
  })

  const handle = (runId: string) =>
    titleRun(runId).pipe(
      Effect.catchTag('TitleNotGenerated', (failure) =>
        skip(runId, `no title was generated: ${failure.reason}`)
      ),
      Effect.catchTag('TabNotFoundError', () =>
        Effect.logWarning('The thread was closed before it was titled', { runId })
      ),
      Effect.forkIn(scope),
      Effect.asVoid
    )

  yield* committed.pipe(
    Stream.runForEach((entry) =>
      Effect.gen(function* () {
        const { event } = entry
        if (event._tag !== 'MessageUpdated' || event.message.role !== 'user') return
        if (!(yield* claim(entry.runId))) return
        yield* handle(entry.runId)
      })
    ),
    Effect.forkScoped
  )
  yield* Effect.logInfo('Automatic thread titling started')
})

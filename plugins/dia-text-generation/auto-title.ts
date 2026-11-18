import type { HostPluginContext } from '@dia/plugin'
import { type CommittedEvent, isGeneratedAgentName, tabOf } from '@dia/plugin'
import { Effect, Result, type Scope, Stream } from 'effect'
import { conversationText } from './conversation'
import type { TitleDeps } from './titling'

type Workspace = Stream.Success<HostPluginContext['workspace']>

/** What {@link startAutoTitle} reads and writes; each member is a seam to the Host. */
export interface AutoTitleDeps extends TitleDeps {
  /** Subscribes to the events committed from now on, as `RunEvents.subscribe` does. */
  readonly events: Effect.Effect<Stream.Stream<CommittedEvent>, never, Scope.Scope>
  /** The workspace as it is when read, as the latest value of `ctx.workspace`. */
  readonly workspace: Effect.Effect<Workspace>
}

const skip = (runId: string, reason: string) =>
  Effect.logDebug('Skipped titling a thread', { runId, reason })

const isUserMessage = (entry: CommittedEvent): boolean =>
  entry.event._tag === 'MessageUpdated' && entry.event.message.role === 'user'

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
  const decided = new Set<string>()
  const committed = yield* deps.events

  const claim = (entry: CommittedEvent): boolean => {
    if (decided.has(entry.runId)) return false
    decided.add(entry.runId)
    return true
  }

  const titleRun = Effect.fnUntraced(function* (runId: string) {
    const { state } = yield* deps.snapshot(runId)
    if (state.messages.filter((message) => message.role === 'user').length > 1) {
      return yield* skip(runId, 'the thread holds more than one user message')
    }
    const found = tabOf(yield* deps.workspace, runId)
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
    Stream.filter(isUserMessage),
    Stream.filter(claim),
    Stream.runForEach((entry) => handle(entry.runId)),
    Effect.forkScoped
  )
  yield* Effect.logInfo('Automatic thread titling started')
})

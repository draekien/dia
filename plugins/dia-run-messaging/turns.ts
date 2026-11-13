import {
  Attention,
  type CommittedEvent,
  PaneAgentEvent,
  PaneChat,
  type RunEvents
} from '@dia/plugin'
import { Clock, Effect, Option, type Scope, Stream } from 'effect'

type ChatState = PaneChat.PaneChatState

/** How a run's work ended: the attention it finished with, folded to four outcomes. */
export type Ending = 'completed' | 'errored' | 'crashed' | 'parked'

/** A run that finished: how it ended and its reply at that point. */
export interface Finish {
  readonly ending: Ending
  readonly reply: string
}

const endingOf = (attention: ChatState['attention']): Option.Option<Ending> => {
  if (Attention.isParkedState(attention)) return Option.some('parked')
  switch (attention._tag) {
    case 'Completed':
      return Option.some('completed')
    case 'Errored':
      return Option.some('errored')
    case 'Crashed':
      return Option.some('crashed')
    default:
      return Option.none()
  }
}

const nothingToRunNext = (state: ChatState) => state.queued.length === 0 || state.queueHeld

/** Whether `state` has no turn in progress and no queued message that runs next. */
export const isSettled = (state: ChatState): boolean => !state.isLoading && nothingToRunNext(state)

/**
 * How many user messages and queued messages of `state` have exactly `text`. A message sent again
 * is seen once this count exceeds the count before the send.
 */
export const timesSeen = (state: ChatState, text: string): number =>
  state.queued.filter((message) => message.text === text).length +
  state.messages.filter(
    (message) =>
      message.role === 'user' &&
      message.parts.some((part) => part.type === 'text' && part.content === text)
  ).length

/** The text of the last assistant message of `state`, or an empty string when it has none. */
export const replyOf = (state: ChatState): string => {
  const last = state.messages.filter((message) => message.role === 'assistant').at(-1)
  if (last === undefined) return ''
  return last.parts
    .flatMap((part) => (part.type === 'text' ? [part.content] : []))
    .join('\n\n')
    .trim()
}

/**
 * One state of a followed run: its chat state, and the event that produced it, or none for the
 * state read before the first event.
 */
export interface RunStep {
  readonly state: ChatState
  readonly event: Option.Option<PaneChat.PaneStreamEvent>
}

const judgesFinish = (event: Option.Option<PaneChat.PaneStreamEvent>) =>
  Option.match(event, {
    onNone: () => true,
    onSome: (paneEvent) =>
      paneEvent._tag === 'PaneAttentionChanged' ||
      (paneEvent._tag === 'PaneMessageQueueChanged' && paneEvent.held)
  })

/**
 * The run's {@link Finish} at `step`, or none while it works. A run finishes when its attention
 * ends a turn while nothing is queued to run next, or when its queue is held after such a turn.
 * Only those events and the first state are judged: a queue emptied after a turn end means its
 * messages are being sent, so the run is about to start a turn.
 */
export const finishOf = (step: RunStep): Option.Option<Finish> =>
  judgesFinish(step.event) && nothingToRunNext(step.state)
    ? Option.map(endingOf(step.state.attention), (ending) => ({
        ending,
        reply: replyOf(step.state)
      }))
    : Option.none()

const paneEventOf = (committed: CommittedEvent) =>
  'paneId' in committed.event
    ? committed.event
    : PaneAgentEvent.make(
        { paneId: committed.runId, agentEvent: committed.event },
        { disableChecks: true }
      )

/**
 * Subscribes to every run's committed events now, in the calling scope, and returns the function
 * that follows one run from the subscription on. Call it before the action whose effect you wait
 * for (a start or a send), then call the returned function once, after the action: it reads the
 * run's chat state and streams it, then the state after each later event of the run, each as a
 * {@link RunStep}.
 */
export const watchRun = Effect.fnUntraced(function* (
  runEvents: RunEvents
): Effect.fn.Return<(runId: string) => Effect.Effect<Stream.Stream<RunStep>>, never, Scope.Scope> {
  const later = yield* runEvents.subscribe
  return (runId: string) =>
    Effect.map(runEvents.snapshot(runId), (snapshot) =>
      later.pipe(
        Stream.filter(
          (committed) => committed.runId === runId && committed.sequence > snapshot.seq
        ),
        Stream.map(paneEventOf),
        Stream.filter(PaneChat.isPaneStreamEvent),
        Stream.scanEffect(
          (): RunStep => ({ state: snapshot.state, event: Option.none() }),
          (step, event) =>
            Effect.map(Clock.currentTimeMillis, (now) => ({
              state: PaneChat.reducePaneChat(step.state, event, now),
              event: Option.some(event)
            }))
        )
      )
    )
})

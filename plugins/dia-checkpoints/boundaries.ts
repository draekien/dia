import { Attention, type StoredEvent } from '@dia/plugin'
import { Data, Option } from 'effect'

const PROMPT_LIMIT = 120

/** Where a run's turn begins or ends, as {@link boundaryOf} reads it from a stored run event. */
export type Boundary = Data.TaggedEnum<{
  /** A turn begins with `prompt`: the first line of its first message, at most 120 characters. */
  TurnStart: { readonly prompt: string }
  /** The run's latest turn ends. */
  TurnEnd: Record<never, never>
}>

/** Constructors for {@link Boundary}. */
export const Boundary = Data.taggedEnum<Boundary>()

const promptOf = (text: string) =>
  (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  ).slice(0, PROMPT_LIMIT)

const endsTurn = (attention: Attention.AttentionState) =>
  attention._tag === 'Completed' ||
  attention._tag === 'Errored' ||
  attention._tag === 'Crashed' ||
  Attention.isParkedState(attention)

/**
 * Whether stored run event `event` starts a turn (`PaneUserMessagesSent`) or ends one (a
 * `PaneAttentionChanged` to `Completed`, `Errored`, `Crashed` or a parked state). Every other
 * event, `Idle` and `AwaitingPermission` included, is `None`: a run is set `Idle` mid-turn.
 */
export const boundaryOf = (event: StoredEvent): Option.Option<Boundary> => {
  switch (event._tag) {
    case 'PaneUserMessagesSent':
      return Option.some(Boundary.TurnStart({ prompt: promptOf(event.messages[0]?.text ?? '') }))
    case 'PaneAttentionChanged':
      return endsTurn(event.attention) ? Option.some(Boundary.TurnEnd()) : Option.none()
    default:
      return Option.none()
  }
}

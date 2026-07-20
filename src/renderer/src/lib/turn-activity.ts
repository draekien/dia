import { Duration } from 'effect'
import type { PaneChatState } from './pane-chat'

/**
 * How long a turn must run before its elapsed-seconds counter is worth showing.
 * Below this the counter would flicker in and out on every fast turn, so it
 * stays hidden until the wait is long enough to be worth acknowledging.
 */
export const ELAPSED_DELAY = Duration.seconds(3)

/**
 * How long a turn can go without visible progress before it is treated as
 * stalled — the point at which the activity line offers a manual resend /
 * interrupt so the user is never stuck waiting on a silent session.
 */
export const STALL_THRESHOLD = Duration.seconds(30)

/**
 * The rotation of light-hearted "still working" verbs shown once a turn is
 * underway. Deliberately excludes "Thinking" (which reads as a distinct SDK
 * state) and any word implying an error. Indexed deterministically per turn so
 * the label is stable across re-renders — see {@link turnActivity}.
 */
export const WORKING_VERBS = [
  'Working',
  'Cooking',
  'Crunching',
  'Churning',
  'Percolating',
  'Noodling',
  'Simmering',
  'Mulling',
  'Wrangling',
  'Tinkering'
] as const

/**
 * A snapshot of what a pane is doing mid-turn, for rendering the activity line.
 * `kind` is `'starting'` on the very first turn before any assistant output has
 * appeared (session warm-up) and `'working'` thereafter. `label` is the text to
 * show. `elapsedLabel` is the formatted seconds-elapsed once past the short
 * delay, or `undefined` before it. `stalled` is true once the turn has gone
 * without progress for {@link STALL_THRESHOLD}, the cue to surface manual
 * resend / interrupt actions.
 */
export interface TurnActivity {
  readonly kind: 'starting' | 'working'
  readonly label: string
  readonly elapsedLabel?: string
  readonly stalled: boolean
}

const DELAY_MS = Duration.toMillis(ELAPSED_DELAY)
const STALL_MS = Duration.toMillis(STALL_THRESHOLD)

const userTurnCount = (state: PaneChatState): number =>
  state.messages.reduce((count, message) => (message.role === 'user' ? count + 1 : count), 0)

const hasAssistantTurn = (state: PaneChatState): boolean =>
  state.messages.some((message) => message.role === 'assistant')

/**
 * Formats a turn's elapsed milliseconds for display: whole seconds under a
 * minute (`"12s"`), and `m:ss` with a zero-padded seconds field at a minute or
 * more (`"1:23"`). Partial seconds are floored, never rounded up.
 */
export const formatElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Derives the activity-line snapshot for a pane, or `null` when no turn is in
 * flight (`state.isLoading` is false). `elapsedMs` is how long the current turn
 * has run and `sinceActivityMs` how long since its last visible progress; the
 * caller owns those clocks. Pure and deterministic — the working verb is chosen
 * from the pane's user-turn count so it stays fixed for the duration of a turn.
 */
export const turnActivity = (
  state: PaneChatState,
  elapsedMs: number,
  sinceActivityMs: number
): TurnActivity | null => {
  if (!state.isLoading) return null

  const kind = hasAssistantTurn(state) ? 'working' : 'starting'
  const label =
    kind === 'starting'
      ? 'Starting session'
      : WORKING_VERBS[userTurnCount(state) % WORKING_VERBS.length]

  return {
    kind,
    label,
    stalled: sinceActivityMs >= STALL_MS,
    ...(elapsedMs >= DELAY_MS ? { elapsedLabel: formatElapsed(elapsedMs) } : {})
  }
}

import {
  PaneAssistantTextDelta,
  PaneTurnStatusChanged,
  PaneUserMessagesSent
} from '@shared/ipc/contract'
import { Duration } from 'effect'
import { describe, expect, it } from 'vitest'
import { emptyPaneChatState, reducePaneChat } from './pane-chat'
import {
  ELAPSED_DELAY,
  formatElapsed,
  STALL_THRESHOLD,
  turnActivity,
  WORKING_VERBS
} from './turn-activity'

const PANE = '00000000-0000-4000-8000-000000000000'

const loadingNoAssistant = reducePaneChat(
  emptyPaneChatState,
  PaneUserMessagesSent.make({ paneId: PANE, messages: [{ id: 'u-1', text: 'hi' }] })
)
const loadingWithAssistant = reducePaneChat(
  loadingNoAssistant,
  PaneAssistantTextDelta.make({ paneId: PANE, text: 'on it' })
)

const DELAY_MS = Duration.toMillis(ELAPSED_DELAY)
const STALL_MS = Duration.toMillis(STALL_THRESHOLD)

describe('formatElapsed', () => {
  it('renders sub-minute durations as whole seconds', () => {
    expect(formatElapsed(5_000)).toBe('5s')
    expect(formatElapsed(12_000)).toBe('12s')
    expect(formatElapsed(59_000)).toBe('59s')
  })

  it('renders a minute or more as minutes and seconds, so it does not read as a clock time', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s')
    expect(formatElapsed(65_000)).toBe('1m 5s')
    expect(formatElapsed(600_000)).toBe('10m 0s')
  })

  it('floors partial seconds rather than rounding up', () => {
    expect(formatElapsed(12_999)).toBe('12s')
  })
})

describe('turnActivity', () => {
  it('returns null when the pane is not loading', () => {
    expect(turnActivity(emptyPaneChatState, 0, 0)).toBeNull()
  })

  it('reports "starting" while loading with no assistant turn yet', () => {
    const activity = turnActivity(loadingNoAssistant, 0, 0)
    expect(activity?.kind).toBe('starting')
    expect(activity?.label).toBe('Starting session…')
  })

  it('reports "working" once an assistant turn has appeared', () => {
    const activity = turnActivity(loadingWithAssistant, 0, 0)
    expect(activity?.kind).toBe('working')
    expect(WORKING_VERBS.map((verb) => `${verb}…`)).toContain(activity?.label)
  })

  it('picks the working verb deterministically from the user-turn count', () => {
    // seed = number of user turns; loadingWithAssistant has one user turn.
    const expected = `${WORKING_VERBS[1 % WORKING_VERBS.length]}…`
    expect(turnActivity(loadingWithAssistant, 0, 0)?.label).toBe(expected)
    // Stable across re-renders within the same turn.
    expect(turnActivity(loadingWithAssistant, 9_999, 0)?.label).toBe(expected)
  })

  it('omits the elapsed label until the short delay has passed', () => {
    expect(turnActivity(loadingWithAssistant, DELAY_MS - 1, 0)?.elapsedLabel).toBeUndefined()
  })

  it('shows the elapsed label once the delay has passed', () => {
    expect(turnActivity(loadingWithAssistant, DELAY_MS, 0)?.elapsedLabel).toBe(
      formatElapsed(DELAY_MS)
    )
  })

  it('is not stalled before the stall threshold', () => {
    expect(turnActivity(loadingWithAssistant, STALL_MS - 1, STALL_MS - 1)?.stalled).toBe(false)
  })

  it('is stalled once no progress has been made for the stall threshold', () => {
    expect(turnActivity(loadingWithAssistant, STALL_MS, STALL_MS)?.stalled).toBe(true)
  })

  it('measures stall from last progress, independently of total elapsed', () => {
    // A long-running but actively-progressing turn (recent activity) is not stalled.
    expect(turnActivity(loadingWithAssistant, STALL_MS * 3, 1_000)?.stalled).toBe(false)
  })
})

describe('turnActivity — named turn state', () => {
  it('shows the turn’s named state as its label, without an ellipsis', () => {
    const retrying = reducePaneChat(
      loadingWithAssistant,
      PaneTurnStatusChanged.make({ paneId: PANE, label: 'Compacting conversation' })
    )
    expect(turnActivity(retrying, 0, 0)).toEqual({
      kind: 'working',
      label: 'Compacting conversation',
      stalled: false
    })
  })
})

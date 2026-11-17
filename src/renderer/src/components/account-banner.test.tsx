// @vitest-environment jsdom

import { RegistryContext } from '@effect/atom-react'
import type { PaneId } from '@shared/domain/pane'
import type { ParkCause } from '@shared/domain/parking'
import {
  NoActivity,
  type RunSummary,
  StatusNeedsInput,
  StatusParked
} from '@shared/domain/run-summary'
import { cleanup, render, screen } from '@testing-library/react'
import { AtomRegistry } from 'effect/reactivity'
import { afterEach, describe, expect, it } from 'vitest'
import { runSummariesAtom } from '../lib/workspace-atoms'
import { AccountBanner } from './account-banner'

afterEach(cleanup)

const RESET_AT = 1_900_000_000_000

const limit = (resetsAt: number | null): ParkCause => ({ _tag: 'UsageLimit', resetsAt })

const summary = (paneId: string, fields: Partial<RunSummary>): RunSummary => ({
  paneId,
  status: StatusNeedsInput.make({ reason: 'x' }),
  activity: NoActivity.make({}),
  ...fields
})

const showBanner = (summaries: ReadonlyArray<RunSummary>) => {
  const registry = AtomRegistry.make({
    initialValues: [
      [runSummariesAtom, new Map(summaries.map((one) => [one.paneId as PaneId, one] as const))]
    ]
  })
  render(
    <RegistryContext.Provider value={registry}>
      <AccountBanner />
    </RegistryContext.Provider>
  )
  return screen.getByRole('status').textContent
}

describe('AccountBanner', () => {
  it('joins a reset limit and the waiting agents with a comma', () => {
    const text = showBanner([
      summary('a', { parked: limit(RESET_AT) }),
      summary('b', { parked: limit(RESET_AT) })
    ])

    expect(text).toBe('Usage limit has reset, 2 agents waitingResume all')
  })

  it('says in a second sentence when the user can resume the agents', () => {
    const text = showBanner([
      summary('a', {
        status: StatusParked.make({ until: RESET_AT, resumedBy: 'user' }),
        parked: limit(RESET_AT)
      })
    ])

    expect(text).toMatch(/^Usage limit reached\. You can resume 1 agent at \S/)
  })

  it('says in a second sentence when dia resumes the agents', () => {
    const text = showBanner([
      summary('a', {
        status: StatusParked.make({ until: RESET_AT, resumedBy: 'dia' }),
        parked: limit(RESET_AT)
      })
    ])

    expect(text).toMatch(/^Usage limit reached\. dia resumes 1 agent at \S/)
  })
})

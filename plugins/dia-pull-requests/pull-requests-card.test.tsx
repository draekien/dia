// @vitest-environment jsdom

import { RightPanel, TooltipProvider } from '@dia/renderer-plugin'
import { RegistryContext } from '@effect/atom-react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { appRegistry } from '../../src/renderer/src/lib/workspace-atoms'
import type { PullRequestAtoms } from './atoms'
import { PullRequestPanel } from './pull-request-panel'
import { fakeAtoms, readPullRequest } from './pull-requests.fake'
import { PullRequestsCard } from './pull-requests-card'

afterEach(cleanup)

const PANEL = { plugin: 'dia-pull-requests', id: 'pull-request' }

const showTab = (runId: string, atoms: PullRequestAtoms) =>
  render(
    <RegistryContext.Provider value={appRegistry}>
      <TooltipProvider>
        <PullRequestsCard runId={runId} atoms={atoms} panel={PANEL} />
        <div
          ref={(element) => {
            if (element) Object.defineProperty(element, 'clientWidth', { value: 1200 })
          }}
        >
          <RightPanel
            paneId={runId}
            panels={[
              {
                key: PANEL,
                id: PANEL.id,
                order: 50,
                title: 'Pull request',
                component: ({ paneId }) => <PullRequestPanel runId={paneId} atoms={atoms} />
              }
            ]}
          />
        </div>
      </TooltipProvider>
    </RegistryContext.Provider>
  )

const twoLinked = () =>
  fakeAtoms([
    readPullRequest(1, { title: 'First change' }),
    readPullRequest(2, { title: 'Second change' })
  ])

const row = (name: string) =>
  screen.findByRole('link', { name: `Show ${name} in the Pull request panel` })

const panelRegion = () => screen.queryByRole('complementary', { name: 'Pull request' })

describe('PullRequestsCard', () => {
  it('opens the Pull request panel on the clicked pull request', async () => {
    showTab('run-click', twoLinked())

    fireEvent.click(await row('#2 Second change'))

    expect(panelRegion()).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Second change' })).toBeTruthy()
  })

  it.each([
    { key: 'Ctrl', modifier: { ctrlKey: true } },
    { key: '⌘', modifier: { metaKey: true } }
  ])('leaves a $key+click to the link, which opens the browser', async ({ modifier }) => {
    showTab(`run-${Object.keys(modifier)[0]}`, twoLinked())
    const link = await row('#2 Second change')

    const notPrevented = fireEvent.click(link, modifier)

    expect(notPrevented).toBe(true)
    expect(link.getAttribute('href')).toBe('https://github.com/draekien/dia/pull/2')
    expect(panelRegion()).toBeNull()
  })

  it('says so when no pull request is linked', async () => {
    showTab('run-empty', fakeAtoms([]))

    expect(await screen.findByText('No pull requests')).toBeTruthy()
  })
})

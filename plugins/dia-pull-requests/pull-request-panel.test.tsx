// @vitest-environment jsdom

import { RegistryContext } from '@effect/atom-react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AtomRegistry } from 'effect/reactivity'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PullRequestAtoms } from './atoms'
import type { LinkedPullRequest } from './calls'
import { PullRequestPanel } from './pull-request-panel'
import type { PullRequestUrl } from './pull-request-url'
import {
  failedPullRequest,
  fakeAtoms,
  prUrl,
  RUN,
  readingPullRequest,
  readPullRequest
} from './pull-requests.fake'

afterEach(cleanup)

const showPanel = (atoms: PullRequestAtoms, shown?: PullRequestUrl) => {
  const registry = AtomRegistry.make()
  registry.set(atoms.shown(RUN), shown)
  return render(
    <RegistryContext.Provider value={registry}>
      <PullRequestPanel runId={RUN} atoms={atoms} />
    </RegistryContext.Provider>
  )
}

const show = (linked: ReadonlyArray<LinkedPullRequest>, shown?: PullRequestUrl) =>
  showPanel(fakeAtoms(linked), shown)

const section = (name: string) => screen.getByRole('region', { name })

describe('PullRequestPanel', () => {
  it('says so when no pull request is linked', async () => {
    show([])

    expect(await screen.findByText('No pull requests linked to this run')).toBeTruthy()
  })

  it('shows the first linked pull request when none was chosen', async () => {
    show([readPullRequest(1, { title: 'First change' }), readPullRequest(2)])

    expect(await screen.findByRole('heading', { name: 'First change' })).toBeTruthy()
  })

  it('shows the pull request the card chose', async () => {
    show([readPullRequest(1), readPullRequest(2, { title: 'Second change' })], prUrl(2))

    expect(await screen.findByRole('heading', { name: 'Second change' })).toBeTruthy()
  })

  it('shows the first when the chosen pull request is no longer linked', async () => {
    show([readPullRequest(1, { title: 'First change' })], prUrl(9))

    expect(await screen.findByRole('heading', { name: 'First change' })).toBeTruthy()
  })

  it('offers a switcher only when two or more pull requests are linked', async () => {
    show([readPullRequest(1, { title: 'First change' })])
    await screen.findByRole('heading', { name: 'First change' })
    expect(screen.queryByRole('combobox', { name: 'Pull request' })).toBeNull()
    cleanup()

    show([readPullRequest(1, { title: 'First change' }), readPullRequest(2)])
    expect(await screen.findByRole('combobox', { name: 'Pull request' })).toBeTruthy()
  })

  it('shows the summary of a read pull request', async () => {
    show([
      readPullRequest(295, {
        title: 'Link pull requests',
        state: 'merged',
        author: 'draekien',
        baseRef: 'main',
        headRef: 'feat/link-pull-requests',
        additions: 1200,
        deletions: 34
      })
    ])

    await screen.findByRole('heading', { name: 'Link pull requests' })
    expect(screen.getByText('#295')).toBeTruthy()
    expect(screen.getByText('Merged')).toBeTruthy()
    expect(screen.getByText('draekien')).toBeTruthy()
    expect(screen.getByText('main ← feat/link-pull-requests')).toBeTruthy()
    expect(screen.getByText(/\+1,200/).textContent).toBe('Lines added +1,200 removed −34')
  })

  it('links each check to its run and names its state', async () => {
    show([
      readPullRequest(1, {
        checks: [
          { name: 'typecheck', state: 'failed', url: 'https://github.com/draekien/dia/runs/1' },
          { name: 'lint', state: 'pending' }
        ]
      })
    ])

    const checks = await screen.findByRole('region', { name: 'Checks' })
    const typecheck = within(checks).getByRole('link', { name: /typecheck/ })
    expect(typecheck.getAttribute('href')).toBe('https://github.com/draekien/dia/runs/1')
    expect(within(checks).getAllByText('Failed')).toHaveLength(1)
    expect(within(checks).queryByRole('link', { name: /lint/ })).toBeNull()
    expect(within(checks).getAllByText('Pending')).toHaveLength(1)
  })

  it('shows reviews and comments with their author, kind and body', async () => {
    show([
      readPullRequest(1, {
        activity: [
          { _tag: 'Review', author: 'reviewer', state: 'changes_requested', body: 'Fix it', at: 1 },
          { _tag: 'Comment', author: 'octocat', body: 'Looks good', at: 2 }
        ]
      })
    ])

    const activity = await screen.findByRole('region', { name: 'Reviews and comments' })
    const [review, comment] = within(activity).getAllByRole('listitem')
    expect(review?.textContent).toContain('reviewerrequested changes')
    expect(review?.textContent).toContain('Fix it')
    expect(comment?.textContent).toContain('octocatcommented')
    expect(comment?.textContent).toContain('Looks good')
  })

  it('shows the description as plain text while no Markdown renderer is loaded', async () => {
    show([readPullRequest(1, { body: '## Summary\n\nAdds a tool.' })])

    await screen.findByRole('region', { name: 'Description' })
    expect(within(section('Description')).getByText(/## Summary/).textContent).toBe(
      '## Summary\n\nAdds a tool.'
    )
  })

  it('says so when a read pull request has no checks, activity or description', async () => {
    show([readPullRequest(1)])

    await screen.findByRole('region', { name: 'Checks' })
    expect(within(section('Checks')).getByText('No checks')).toBeTruthy()
    expect(within(section('Reviews and comments')).getByText('No reviews or comments')).toBeTruthy()
    expect(within(section('Description')).getByText('No description')).toBeTruthy()
  })

  it('shows the number and a placeholder while the pull request is read', async () => {
    show([readingPullRequest(7)])

    expect(await screen.findByText('#7')).toBeTruthy()
    expect(screen.getByText('Reading the pull request')).toBeTruthy()
  })

  it('shows why the read failed', async () => {
    show([failedPullRequest(7, 'GitHub CLI is not logged in. Run gh auth login.')])

    expect(await screen.findByText('GitHub CLI is not logged in. Run gh auth login.')).toBeTruthy()
  })

  it('opens the pull request in the browser from its link', async () => {
    show([readPullRequest(7)])

    const open = await screen.findByRole('link', { name: 'Open in browser' })
    expect(open.getAttribute('href')).toBe('https://github.com/draekien/dia/pull/7')
    expect(open.getAttribute('target')).toBe('_blank')
  })

  it.each([
    { button: 'Refresh', action: 'refresh' },
    { button: 'Unlink', action: 'unlink' }
  ] as const)('asks the host to $action the shown pull request', async ({ button, action }) => {
    const spy = vi.fn((_runId: string, _url: PullRequestUrl) => Promise.resolve())
    showPanel(
      fakeAtoms([readPullRequest(1), failedPullRequest(2, 'gone')], { [action]: spy }),
      prUrl(2)
    )

    fireEvent.click(await screen.findByRole('button', { name: button }))

    expect(spy).toHaveBeenCalledWith(RUN, prUrl(2))
  })
})

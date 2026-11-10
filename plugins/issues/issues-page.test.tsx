// @vitest-environment jsdom
import { followHost, toast } from '@dia/renderer-plugin'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Atom } from 'effect/reactivity'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchIssues } from './calls'
import { AssigneeRef, Issue, IssueNotInTriage, ProviderId } from './domain'
import {
  assignee,
  type FakeIssuesHost,
  installIssuesHost,
  issueId,
  objectiveId,
  PROJECTS,
  type Reply,
  refusal,
  VIEW,
  withIssue
} from './issues-host.fake'
import { IssuesPage } from './issues-page'

const ctx = { name: 'issues' }

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {}
  window.HTMLElement.prototype.hasPointerCapture = () => false
  window.HTMLElement.prototype.releasePointerCapture = () => {}
})
beforeEach(() => {
  vi.spyOn(toast, 'add').mockImplementation(() => '')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'dia')
})

const renderIssues = async (host: FakeIssuesHost, target?: string) => {
  render(
    <IssuesPage
      ctx={ctx}
      issuesAtom={Atom.make(followHost(ctx, WatchIssues, {}))}
      target={target}
    />
  )
  await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull())
  await act(async () => {})
  return host
}

const click = (name: string | RegExp) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })

const openSelect = (select: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: select }))
  })

const choose = async (select: string, option: string) => {
  await openSelect(select)
  const item = screen.getByRole('option', { name: option, hidden: true })
  await act(async () => {
    fireEvent.pointerDown(item, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseDown(item, { button: 0 })
    fireEvent.pointerUp(item, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseUp(item, { button: 0 })
    fireEvent.click(item)
  })
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

const sentTags = (host: FakeIssuesHost) => host.sent.map(([tag]) => tag)

const failWith = (error: unknown) => (): Reply => ({ error })

const facts = () =>
  Object.fromEntries(
    [...document.querySelectorAll('dl > div')].map((row) => [
      row.querySelector('dt')?.textContent,
      row.querySelector('dd')?.textContent
    ])
  )

const detailTitle = () => screen.getByRole('heading', { level: 3 }).textContent

const issueRow = (title: string) => screen.getByRole('listitem', { name: title })

const openObjective = async (host: FakeIssuesHost, n = 1) => {
  await renderIssues(host, objectiveId(n))
  await screen.findByRole('heading', { level: 3 })
  return host
}

const press = (name: string, scope?: HTMLElement) =>
  act(async () => {
    fireEvent.click((scope ? within(scope) : screen).getByRole('button', { name }))
  })

describe('Objectives list', () => {
  const rowNames = () =>
    [...document.querySelectorAll('[data-slot="list-row-name"]')].map((name) => name.textContent)

  it('lists open objectives by priority, and completed ones last', async () => {
    await renderIssues(installIssuesHost())

    expect(rowNames()).toEqual([
      'Ship the objective screen',
      'Tidy release notes',
      'Move settings to SQLite'
    ])
  })

  it('shows each objective with its project, state and priority', async () => {
    await renderIssues(installIssuesHost())

    const row = screen.getByRole('button', { name: /^Tidy release notes/ })

    expect(within(row).getByText('website')).toBeTruthy()
    expect(within(row).getByText('Open')).toBeTruthy()
    expect(within(row).getByText('Normal')).toBeTruthy()
  })

  it('draws an open objective half filled and a completed one full', async () => {
    await renderIssues(installIssuesHost())

    const fill = (title: string) =>
      screen
        .getByRole('button', { name: new RegExp(`^${title}`) })
        .querySelector('[data-slot="status-media"]')?.className

    expect(fill('Ship the objective screen')).toContain('linear-gradient')
    expect(fill('Move settings to SQLite')).toContain('bg-current')
  })

  it('opens an objective from its row, and goes back from Objectives', async () => {
    await renderIssues(installIssuesHost())

    await click(/^Tidy release notes/)
    const opened = detailTitle()
    await click('Objectives')

    expect(opened).toBe('Tidy release notes')
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
  })

  it('opens on the objective a link targets', async () => {
    await openObjective(installIssuesHost(), 2)

    expect(detailTitle()).toBe('Tidy release notes')
  })

  it('opens on the list for a target that is not an objective id', async () => {
    await renderIssues(installIssuesHost(), 'not-an-objective')

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Objectives')
  })

  it('shows the empty state when there are no objectives', async () => {
    await renderIssues(installIssuesHost({}, { ...VIEW, objectives: [], issues: [], comments: [] }))

    expect(await screen.findByText('No objectives yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New objective…' })).toBeTruthy()
  })

  it('says the host entry is not loaded when it is not serving WatchIssues', async () => {
    const host = installIssuesHost()
    Object.assign(window.dia.plugins, {
      subscribe: (
        _plugin: string,
        tag: string,
        _payload: unknown,
        _onValue: unknown,
        onEnd: (end: unknown) => void
      ) => {
        queueMicrotask(() =>
          onEnd({
            _tag: 'PluginSubscriptionFailure',
            error: { _tag: 'PluginNotServing', plugin: 'issues', tag, message: 'not loaded' }
          })
        )
        return () => {}
      }
    })
    await renderIssues(host)

    expect(await screen.findByText("The issues plugin's host entry is not loaded.")).toBeTruthy()
  })
})

describe('Objective screen', () => {
  it('shows the objective facts', async () => {
    await openObjective(installIssuesHost())

    expect(facts()).toEqual({
      Project: 'dia',
      Priority: 'High',
      State: 'Open',
      Assignee: 'Ada',
      Description: 'List objectives beside a detail, and show every issue with its status.'
    })
  })

  it('shows Unassigned and No description for an objective with neither', async () => {
    await openObjective(installIssuesHost(), 2)

    expect(facts()).toMatchObject({ Assignee: 'Unassigned', Description: 'No description' })
  })

  it('shows a completed objective as Completed, without Add issue', async () => {
    await openObjective(installIssuesHost(), 3)

    expect(facts().State).toBe('Completed')
    expect(screen.queryByRole('button', { name: 'Add issue' })).toBeNull()
  })

  it('nests a sub-issue under its parent', async () => {
    await openObjective(installIssuesHost())

    expect(
      within(issueRow('Build the objective screen')).queryByText('Test the issue tree')
    ).not.toBeNull()
    expect(
      within(issueRow('Build the objective screen')).queryByText('Write the release note')
    ).toBeNull()
  })

  it.each([
    ['Plan: Ship the objective screen', 'Planning'],
    ['Retro: Stream the work view', 'Retro']
  ])('marks %s as %s', async (title, kind) => {
    await openObjective(installIssuesHost())

    expect(within(issueRow(title)).queryByText(kind)).not.toBeNull()
  })

  it.each([
    ['Add keyboard shortcuts', 'Triage', 'border-dashed'],
    ['Write the release note', 'Todo', 'border-dashed'],
    ['Build the objective screen', 'Implementing', 'linear-gradient'],
    ['Show the status labels', 'In Review', 'linear-gradient'],
    ['Stream the work view', 'Done', 'bg-current'],
    ['Export objectives as CSV', 'Canceled', 'border-dashed']
  ])('labels %s with its status %s and its fill', async (title, label, fill) => {
    await openObjective(installIssuesHost())

    const status = within(issueRow(title)).getAllByText(label)[0]?.closest('[data-slot="status"]')

    expect(status?.querySelector('[data-slot="status-media"]')?.className).toContain(fill)
  })

  it('shows the refusal of a triage issue unchanged', async () => {
    const text = 'Cannot start: missing github (MCP server)'
    await openObjective(
      installIssuesHost(
        {},
        withIssue(VIEW, 8, (existing) => Issue.make({ ...existing, refusal: refusal(text) }))
      )
    )

    expect(within(issueRow('Document the statuses')).queryByText(text)).not.toBeNull()
  })

  it('shows an issue status the host pushes without any user action', async () => {
    const host = await openObjective(installIssuesHost())
    const before = within(issueRow('Write the release note')).queryByText('Implementing')

    await act(async () => {
      host.push(
        withIssue(VIEW, 6, (existing) => Issue.make({ ...existing, status: 'implementing' }))
      )
    })

    expect(before).toBeNull()
    expect(within(issueRow('Write the release note')).queryByText('Implementing')).not.toBeNull()
  })

  it('groups the assignees under their provider label', async () => {
    await openObjective(installIssuesHost())

    await openSelect('Assignee of Write the release note')

    const group = screen.getByText('Org').closest('[role="group"]') as HTMLElement
    expect(
      within(group)
        .getAllByRole('option', { hidden: true })
        .map((option) => option.textContent)
    ).toEqual(['Ada', 'Bea', 'Quality engineer', 'Cy'])
  })

  it('sends AssignIssue with the chosen assignee reference', async () => {
    const host = await openObjective(installIssuesHost())

    await choose('Assignee of Write the release note', 'Bea')

    await waitFor(() =>
      expect(host.sent).toContainEqual([
        'AssignIssue',
        { issueId: issueId(6), assignee: { provider: 'org', id: assignee(2).id } }
      ])
    )
  })

  it('offers the assignee select on triage and todo issues only, and shows the others', async () => {
    await openObjective(installIssuesHost())

    const select = (title: string) =>
      screen.queryByRole('combobox', { name: `Assignee of ${title}` }) !== null

    expect(
      [
        'Add keyboard shortcuts',
        'Write the release note',
        'Build the objective screen',
        'Show the status labels',
        'Stream the work view'
      ].map(select)
    ).toEqual([true, true, false, false, false])
    expect(within(issueRow('Build the objective screen')).getAllByText('Bea')).toHaveLength(2)
  })

  it.each([
    ['a provider that no longer lists it', 'org', 'Removed assignee'],
    ['a provider that is not loaded', 'tracker', 'tracker not loaded']
  ])('names an assignee of %s', async (_case, provider, label) => {
    const gone = AssigneeRef.make({ provider: ProviderId.make(provider), id: 'gone' })
    await openObjective(
      installIssuesHost(
        {},
        withIssue(VIEW, 9, (existing) => Issue.make({ ...existing, assignee: gone }))
      )
    )

    expect(
      issueRow('Show the status labels').querySelector('[data-slot="entity-name"]')?.textContent
    ).toBe(label)
  })

  it('offers Finish on every started issue, and sends FinishIssue from it', async () => {
    const host = await openObjective(installIssuesHost())
    const finishes = screen
      .getAllByRole('button', { name: 'Finish' })
      .map((button) => button.closest('li')?.getAttribute('aria-label'))

    await press('Finish', issueRow('Build the objective screen'))

    expect(finishes).toEqual(['Build the objective screen', 'Show the status labels'])
    await waitFor(() => expect(host.sent).toContainEqual(['FinishIssue', { issueId: issueId(2) }]))
  })

  it.each([
    ['Accept', 'accept', 'Todo'],
    ['Decline', 'decline', 'Canceled']
  ])(
    'sends TriageIssues from %s on a triage issue and the issue moves',
    async (name, decision, label) => {
      const host = await openObjective(installIssuesHost())

      await press(name, issueRow('Add keyboard shortcuts'))

      await waitFor(() =>
        expect(host.sent).toContainEqual(['TriageIssues', { issueIds: [issueId(7)], decision }])
      )
      await waitFor(() =>
        expect(within(issueRow('Add keyboard shortcuts')).queryByText(label)).not.toBeNull()
      )
    }
  )

  it('offers Accept and Decline on triage issues only', async () => {
    await openObjective(installIssuesHost())

    const rowsWith = (name: string) =>
      screen
        .getAllByRole('button', { name })
        .map((button) => button.closest('li')?.getAttribute('aria-label'))

    expect(rowsWith('Accept')).toEqual(['Add keyboard shortcuts', 'Document the statuses'])
    expect(rowsWith('Decline')).toEqual(['Add keyboard shortcuts', 'Document the statuses'])
  })

  it.each([
    ['Accept all', 'accept'],
    ['Decline all', 'decline']
  ])('sends TriageIssues with every triage issue from %s', async (name, decision) => {
    const host = await openObjective(installIssuesHost())

    await press(name)

    await waitFor(() =>
      expect(host.sent).toContainEqual([
        'TriageIssues',
        { issueIds: [issueId(7), issueId(8)], decision }
      ])
    )
  })

  it('counts the triage issues in the bar, singular for one', async () => {
    const host = await openObjective(installIssuesHost())
    const before = screen.queryByText('2 issues in Triage')

    await press('Accept', issueRow('Add keyboard shortcuts'))

    expect(before).not.toBeNull()
    expect(await screen.findByText('1 issue in Triage')).toBeTruthy()
    expect(host.sent).toHaveLength(1)
  })

  it('hides the Triage bar when no issue is in triage', async () => {
    await openObjective(installIssuesHost())

    await press('Accept all')

    await waitFor(() => expect(screen.queryByText(/in Triage$/)).toBeNull())
    expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull()
  })

  it('shows the first line of an issue description and none for an empty one', async () => {
    await openObjective(installIssuesHost())

    expect(
      within(issueRow('Build the objective screen')).queryByText(
        'A list of objectives beside the selected one.'
      )
    ).not.toBeNull()
    expect(within(issueRow('Build the objective screen')).queryByText(/Show its issues/)).toBeNull()
  })

  it('shows a comment under its issue with its author, and Removed assignee for no author', async () => {
    await openObjective(installIssuesHost())

    const commentOf = (body: string) => within(screen.getByText(body).closest('li') as HTMLElement)

    expect(commentOf('The tree nests sub-issues under their parent.').getByText('Bea')).toBeTruthy()
    expect(commentOf('Ready for review.').getByText('Removed assignee')).toBeTruthy()
  })

  it('toasts why accepting an issue failed when it is no longer in Triage', async () => {
    await openObjective(
      installIssuesHost({
        TriageIssues: failWith(
          IssueNotInTriage.make({ issueId: issueId(7), status: 'implementing' })
        )
      })
    )

    await press('Accept', issueRow('Add keyboard shortcuts'))

    expect(vi.mocked(toast.add).mock.calls[0]?.[0]).toMatchObject({
      title: 'Could not accept Add keyboard shortcuts',
      description: 'This issue is no longer in Triage'
    })
  })

  it('sends CreateIssue with an empty description from Add issue and shows the new issue', async () => {
    const host = await openObjective(installIssuesHost())

    type('Issue title', '  Review the screen  ')
    await choose('Assignee of the new issue', 'Cy')
    await click('Add issue')

    const [, payload] = host.sent.find(([tag]) => tag === 'CreateIssue') ?? []
    expect(payload).toEqual({
      issue: {
        id: expect.any(String),
        objectiveId: objectiveId(1),
        parentIssueId: null,
        title: 'Review the screen',
        description: '',
        assignee: { provider: 'org', id: assignee(4).id }
      }
    })
    expect(await screen.findByRole('listitem', { name: 'Review the screen' })).toBeTruthy()
  })

  it('sends CreateIssue with no assignee when none is chosen', async () => {
    const host = await openObjective(installIssuesHost())

    type('Issue title', 'Review the screen')
    await click('Add issue')

    const [, payload] = host.sent.find(([tag]) => tag === 'CreateIssue') ?? []
    expect(payload).toMatchObject({ issue: { assignee: null } })
  })

  it('rejects an empty issue title without a call', async () => {
    const host = await openObjective(installIssuesHost())

    await click('Add issue')

    expect(screen.getByRole('alert').textContent).toBe('Enter a title')
    expect(sentTags(host)).not.toContain('CreateIssue')
  })
})

describe('New objective dialog', () => {
  const create = () =>
    act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create' }))
    })

  const openDialog = async (host: FakeIssuesHost) => {
    await renderIssues(host)
    await click('New objective…')
    return host
  }

  it('offers only the registered projects, and no assignee', async () => {
    await openDialog(installIssuesHost())

    await openSelect('Project')

    expect(
      screen.getAllByRole('option', { hidden: true }).map((option) => option.textContent)
    ).toEqual(PROJECTS.map((project) => project.name))
    expect(within(screen.getByRole('dialog')).queryByText('Assignee')).toBeNull()
  })

  it('sends CreateObjective with no assignee and shows the new objective with no issues', async () => {
    const host = await openDialog(installIssuesHost())

    await choose('Project', 'website')
    type('Title', '  Launch the docs site  ')
    type('Description', 'Write the getting started guide.')
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'High' }))
    })
    await create()

    const [, payload] = host.sent.find(([tag]) => tag === 'CreateObjective') ?? []
    expect(payload).toEqual({
      objective: {
        id: expect.any(String),
        projectId: PROJECTS[1].id,
        title: 'Launch the docs site',
        description: 'Write the getting started guide.',
        priority: 'high',
        assignee: null
      }
    })
    await waitFor(() => expect(detailTitle()).toBe('Launch the docs site'))
    expect(screen.getByText('No issues yet.')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([
    ['an empty title', '   ', 'Enter a title'],
    ['a 121-character title', 'x'.repeat(121), 'Use at most 120 characters']
  ])('rejects %s without a call', async (_case, title, message) => {
    const host = await openDialog(installIssuesHost())

    type('Title', title)
    await create()

    expect(within(screen.getByRole('dialog')).getByText(message)).toBeTruthy()
    expect(sentTags(host)).not.toContain('CreateObjective')
  })

  it('accepts a 120-character title', async () => {
    const host = await openDialog(installIssuesHost())

    type('Title', 'x'.repeat(120))
    await create()

    await waitFor(() => expect(sentTags(host)).toContain('CreateObjective'))
  })
})

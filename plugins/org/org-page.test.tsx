// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the skeleton test holds the read open with a Promise that never resolves.
import { AgentName, type PluginServices, type PluginSetup } from '@dia/plugin'
import { callHost, followHost, openSettings, toast } from '@dia/renderer-plugin'
import { McpServersEditorKey, type McpServersEditorProps } from '@dia-plugin/mcp/editor'
import type { McpServersDraft } from '@dia-plugin/mcp/servers'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Atom } from 'effect/reactivity'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import { ReadOrg, WatchWork } from './calls'
import {
  HiredAgent,
  HireNameTaken,
  HireNotFound,
  IssueNotInTriage,
  JobTitleDisabled,
  JobTitleHasHires,
  JobTitleNameTaken,
  JobTitleNotFound,
  ReportsToCycle
} from './domain'
import {
  type FakeHost,
  HIRES,
  hireId,
  installHost,
  issueId,
  JOB_TITLES,
  jobTitleNamed,
  objectiveId,
  PROJECTS,
  type Reply,
  snapshotOf,
  WORK
} from './org-host.fake'
import { OrgPage } from './org-page'

vi.mock('@dia/renderer-plugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dia/renderer-plugin')>()),
  openSettings: vi.fn()
}))

const ctx = { name: 'org' }
const REVIEWER = jobTitleNamed('Reviewer')
const TEAM_LEAD = jobTitleNamed('Team lead')

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {}
  window.HTMLElement.prototype.hasPointerCapture = () => false
  window.HTMLElement.prototype.releasePointerCapture = () => {}
})
const StubMcpServersEditor = ({ id, draft, onChange, error }: McpServersEditorProps) => (
  <>
    <textarea
      id={id}
      value={draft}
      aria-invalid={error !== undefined}
      onChange={(event) => onChange(event.target.value as McpServersDraft)}
    />
    {error === undefined ? null : <p>{error}</p>}
  </>
)

const mcp: PluginSetup<PluginServices> = (services) =>
  services.provide(McpServersEditorKey, StubMcpServersEditor)

beforeEach(async () => {
  vi.spyOn(toast, 'add').mockImplementation(() => '')
  await startRendererRegistry({ mcp })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.mocked(openSettings).mockClear()
  Reflect.deleteProperty(window, 'dia')
})

const renderOrg = async (host: FakeHost) => {
  const orgAtom = Atom.make(callHost(ctx, ReadOrg, {}))
  render(
    <OrgPage ctx={ctx} orgAtom={orgAtom} workAtom={Atom.make(followHost(ctx, WatchWork, {}))} />
  )
  await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull())
  await act(async () => {})
  return host
}

const go = (page: string) =>
  act(async () => {
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Org pages' })).getByRole('button', {
        name: page
      })
    )
  })

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

const typeInDialog = (value: string) =>
  fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Name'), {
    target: { value }
  })

const sentTags = (host: FakeHost) => host.sent.map(([tag]) => tag)

const notLoaded = (): Reply => ({ notServing: 'The org plugin is not loaded' })

const failWith = (error: unknown) => (): Reply => ({ error })

describe('Org page', () => {
  it('opens on Dashboard', async () => {
    await renderOrg(installHost(snapshotOf()))

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Dashboard')
  })

  it.each(['Objectives', 'Org chart', 'Job titles', 'Hired agents', 'Dashboard'])(
    'shows %s with a heading naming it',
    async (page) => {
      await renderOrg(installHost(snapshotOf()))

      await go(page)

      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(page)
    }
  )

  it('shows the message of a read that failed, with Try again', async () => {
    Object.assign(window, {
      dia: {
        plugins: {
          call: async () => ({
            _tag: 'Failure',
            error: {
              _tag: 'PluginNotServing',
              plugin: 'org',
              tag: 'ReadOrg',
              message: 'The org plugin is not loaded'
            }
          })
        }
      }
    })
    render(
      <OrgPage
        ctx={ctx}
        orgAtom={Atom.make(callHost(ctx, ReadOrg, {}))}
        workAtom={Atom.make(followHost(ctx, WatchWork, {}))}
      />
    )

    expect(await screen.findByText('The org plugin is not loaded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('shows a skeleton until the first read arrives', () => {
    Object.assign(window, { dia: { plugins: { call: () => new Promise(() => {}) } } })
    const { container } = render(
      <OrgPage
        ctx={ctx}
        orgAtom={Atom.make(callHost(ctx, ReadOrg, {}))}
        workAtom={Atom.make(followHost(ctx, WatchWork, {}))}
      />
    )

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
  })
})

describe('Dashboard', () => {
  it('shows the hire count, enabled job titles and the overall cap', async () => {
    const titles = JOB_TITLES.map((title, index) =>
      index === 0 ? { ...title, enabled: false } : title
    )
    await renderOrg(installHost(snapshotOf({ jobTitles: titles })))

    const stats = Array.from(document.querySelectorAll('dl > div')).map((stat) =>
      stat.textContent?.replace('Change', '')
    )
    expect(stats).toEqual([
      `Hired agents${HIRES.length}`,
      `Job titles${JOB_TITLES.length - 1} of ${JOB_TITLES.length} enabled`,
      'Running at once4'
    ])
  })

  it('opens Settings › Org from Change', async () => {
    await renderOrg(installHost(snapshotOf()))

    await click('Change')

    expect(vi.mocked(openSettings).mock.calls).toEqual([[{ plugin: 'org', id: 'org' }]])
  })

  it('says nothing needs attention while agents are hired', async () => {
    await renderOrg(installHost(snapshotOf()))

    expect(screen.getByText('Nothing needs attention.')).toBeTruthy()
  })

  it('shows the no-hires item, whose Hire… opens the Hire dialog', async () => {
    await renderOrg(installHost(snapshotOf({ hiredAgents: [] })))
    expect(
      screen.getByText('No agents are hired. Hire one to start building the org.')
    ).toBeTruthy()

    await click('Hire…')

    expect(screen.getByRole('dialog', { name: 'Hire an agent' })).toBeTruthy()
  })
})

describe('Org chart', () => {
  it('draws an agent under its manager', async () => {
    await renderOrg(installHost(snapshotOf()))

    await go('Org chart')

    const ada = screen.getByRole('button', { name: /^Ada/ }).closest('li')
    const bea = within(ada as HTMLElement)
      .getByRole('button', { name: /^Bea/ })
      .closest('li')
    expect(
      within(bea as HTMLElement).getByRole('button', { name: /^Unnamed Quality engineer/ })
    ).toBeTruthy()
    expect(within(ada as HTMLElement).queryByRole('button', { name: /^Cy/ })).toBeNull()
  })

  it('shows the selected agent on Hired agents', async () => {
    await renderOrg(installHost(snapshotOf()))
    await go('Org chart')

    await click(/^Bea/)

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Hired agents')
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Bea')
  })
})

describe('Job titles', () => {
  const showReviewer = async (host: FakeHost) => {
    await renderOrg(host)
    await go('Job titles')
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /^Reviewer/ }))
    })
  }

  it('lists each job title with its hire count', async () => {
    await renderOrg(installHost(snapshotOf()))

    await go('Job titles')

    expect(screen.getByRole('option', { name: /^Team lead/ }).textContent).toBe('Team leadHired: 1')
    expect(screen.getByRole('option', { name: /^Reviewer/ }).textContent).toBe('ReviewerHired: 0')
  })

  it('shows the selected job title with its enabled switch and its agents', async () => {
    await renderOrg(installHost(snapshotOf()))
    await go('Job titles')

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /^Team lead/ }))
    })

    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Team lead')
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ada' })).toBeTruthy()
  })

  it('offers Delete… on a copy only', async () => {
    await renderOrg(installHost(snapshotOf()))
    await go('Job titles')
    const onBuiltIn = screen.queryByRole('button', { name: 'Delete…' })

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /^Reviewer/ }))
    })

    expect([onBuiltIn, screen.queryByRole('button', { name: 'Delete…' })]).toEqual([
      null,
      expect.anything()
    ])
  })

  it('deletes a copy only on the confirm button', async () => {
    const host = installHost(snapshotOf())
    await showReviewer(host)

    await click('Delete…')
    const beforeConfirm = sentTags(host)
    await click('Delete')

    expect([beforeConfirm, host.sent]).toEqual([
      [],
      [['DeleteJobTitle', { jobTitleId: REVIEWER.id }]]
    ])
  })

  it('shows JobTitleHasHires in the delete dialog', async () => {
    await showReviewer(
      installHost(snapshotOf(), {
        DeleteJobTitle: failWith(JobTitleHasHires.make({ jobTitleId: REVIEWER.id, hires: 2 }))
      })
    )

    await click('Delete…')
    await click('Delete')

    expect(screen.getByRole('alert').textContent).toBe('Dismiss its 2 hired agents first')
  })

  it('treats JobTitleNotFound on delete as deleted: closes the dialog and reads again', async () => {
    const host = installHost(snapshotOf(), {
      DeleteJobTitle: failWith(JobTitleNotFound.make({ jobTitleId: REVIEWER.id }))
    })
    await showReviewer(host)
    const readsBefore = host.reads()

    await click('Delete…')
    await click('Delete')

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(host.reads()).toBe(readsBefore + 1)
  })

  it('copies a job title under the typed name', async () => {
    const host = installHost(snapshotOf())
    await showReviewer(host)

    await click('Copy…')
    typeInDialog('Senior reviewer')
    await click('Copy')

    expect(host.sent).toEqual([
      ['CopyJobTitle', { jobTitleId: REVIEWER.id, name: 'Senior reviewer' }]
    ])
  })

  it('sends nothing for a blank copy name and says why', async () => {
    const host = installHost(snapshotOf())
    await showReviewer(host)

    await click('Copy…')
    typeInDialog('   ')
    await click('Copy')

    expect([host.sent, screen.getByText('Enter a name')]).toEqual([[], expect.anything()])
  })

  it('shows JobTitleNameTaken under the name field', async () => {
    await showReviewer(
      installHost(snapshotOf(), {
        CopyJobTitle: failWith(JobTitleNameTaken.make({ jobTitleName: REVIEWER.name }))
      })
    )

    await click('Copy…')
    typeInDialog('Reviewer')
    await click('Copy')

    expect(screen.getByText('A job title named "Reviewer" already exists')).toBeTruthy()
  })

  it('saves only the fields that changed', async () => {
    const host = installHost(snapshotOf())
    await showReviewer(host)

    type('Job description', 'Reviews every change.')
    type('Deny', 'Bash(git push *)\n')
    await click('Save')

    expect(host.sent).toEqual([
      [
        'EditJobTitle',
        {
          jobTitleId: REVIEWER.id,
          edit: {
            jobDescription: 'Reviews every change.',
            permissions: { allow: [], ask: [], deny: ['Bash(git push *)'] }
          }
        }
      ]
    ])
  })

  it('saves the chosen model and thinking level', async () => {
    const host = installHost(snapshotOf())
    await showReviewer(host)

    await choose('Model', 'Opus')
    await choose('Thinking', 'High')
    await click('Save')

    expect(host.sent).toEqual([
      ['EditJobTitle', { jobTitleId: REVIEWER.id, edit: { model: 'opus', thinkingLevel: 'high' } }]
    ])
  })

  it('names the first listed model as the default model', async () => {
    await showReviewer(installHost(snapshotOf()))

    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toMatch(
      /^Default \(Default model\)/
    )
  })

  it('keeps Save disabled when an edit changes only blank lines', async () => {
    await showReviewer(installHost(snapshotOf()))

    type('Skills', '\n\n')

    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the MCP servers issue and sends nothing for invalid JSON', async () => {
    const host = installHost(snapshotOf())
    await showReviewer(host)

    type('MCP servers', '{ "files": ')
    await click('Save')

    expect(host.sent).toEqual([])
    expect(screen.getByLabelText('MCP servers').getAttribute('aria-invalid')).toBe('true')
  })

  it('saves edited MCP servers with stdio defaults filled', async () => {
    const host = installHost(snapshotOf())
    await showReviewer(host)

    type('MCP servers', '{ "files": { "command": "npx" } }')
    await click('Save')

    expect(host.sent).toEqual([
      [
        'EditJobTitle',
        {
          jobTitleId: REVIEWER.id,
          edit: { mcpServers: { files: { type: 'stdio', command: 'npx', args: [], env: {} } } }
        }
      ]
    ])
  })

  it('shows a hint for MCP servers and still saves other fields while mcp is not loaded', async () => {
    await startRendererRegistry({})
    const host = installHost(snapshotOf())
    await showReviewer(host)

    type('Job description', 'Reviews every change.')
    await click('Save')

    expect([screen.queryByText('Load the mcp plugin to edit MCP servers'), host.sent]).toEqual([
      expect.anything(),
      [
        [
          'EditJobTitle',
          { jobTitleId: REVIEWER.id, edit: { jobDescription: 'Reviews every change.' } }
        ]
      ]
    ])
  })

  it('shows This job title was removed when an edit finds it gone', async () => {
    await showReviewer(
      installHost(snapshotOf(), {
        EditJobTitle: failWith(JobTitleNotFound.make({ jobTitleId: REVIEWER.id }))
      })
    )

    type('Job description', 'Reviews every change.')
    await click('Save')

    expect(screen.getByRole('alert').textContent).toBe('This job title was removed')
  })

  it('shows an error toast when a job title cannot be disabled', async () => {
    await renderOrg(
      installHost(snapshotOf(), {
        SetJobTitleEnabled: notLoaded
      })
    )
    await go('Job titles')

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    })

    expect(vi.mocked(toast.add).mock.calls[0]?.[0]).toMatchObject({
      title: 'Could not disable Product manager',
      description: 'The org plugin is not loaded'
    })
  })

  it('hides the bypass opt-in when bypass is unavailable', async () => {
    await renderOrg(installHost(snapshotOf({ bypassAvailable: false })))

    await go('Job titles')

    expect(screen.queryByText('Bypass approvals')).toBeNull()
  })
})

describe('Hired agents', () => {
  const showAgent = async (host: FakeHost, name: RegExp) => {
    await renderOrg(host)
    await go('Hired agents')
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name }))
    })
    return host
  }

  it('renames the agent', async () => {
    const host = await showAgent(installHost(snapshotOf()), /^Bea/)

    await click('Rename')
    typeInDialog('Beatrice')
    await click(/^Rename$/)

    expect(host.sent.at(-1)).toEqual(['RenameHire', { hireId: hireId(2), name: 'Beatrice' }])
  })

  it('shows HireNameTaken under the rename field', async () => {
    await showAgent(
      installHost(snapshotOf(), {
        RenameHire: failWith(HireNameTaken.make({ agentName: AgentName.make('Ada') }))
      }),
      /^Bea/
    )

    await click('Rename')
    typeInDialog('Ada')
    await click(/^Rename$/)

    expect(screen.getByText('An agent named "Ada" already exists')).toBeTruthy()
  })

  it('shows This agent was dismissed when a rename finds it gone, and reads again', async () => {
    const host = await showAgent(
      installHost(snapshotOf(), {
        RenameHire: failWith(HireNotFound.make({ hireId: hireId(2) }))
      }),
      /^Bea/
    )
    const readsBefore = host.reads()

    await click('Rename')
    typeInDialog('Beatrice')
    await click(/^Rename$/)

    expect([screen.getByText('This agent was dismissed'), host.reads()]).toEqual([
      expect.anything(),
      readsBefore + 1
    ])
  })

  it('dismisses only on the confirm button, saying where the reports go', async () => {
    const host = await showAgent(installHost(snapshotOf()), /^Bea/)

    await click('Dismiss…')
    const beforeConfirm = sentTags(host)
    const description = screen.getByText(/will report to/).textContent
    await click('Dismiss')

    expect([beforeConfirm, description, host.sent]).toEqual([
      [],
      'Its report will report to Ada.',
      [['Dismiss', { hireId: hireId(2) }]]
    ])
  })

  it('treats HireNotFound on Dismiss as dismissed and reads again', async () => {
    const host = await showAgent(
      installHost(snapshotOf(), { Dismiss: failWith(HireNotFound.make({ hireId: hireId(4) })) }),
      /^Cy/
    )
    const readsBefore = host.reads()

    await click('Dismiss…')
    await click('Dismiss')

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(host.reads()).toBe(readsBefore + 1)
  })

  it('shows why a dismiss failed in the dialog', async () => {
    await showAgent(
      installHost(snapshotOf(), {
        Dismiss: notLoaded
      }),
      /^Cy/
    )

    await click('Dismiss…')
    await click('Dismiss')

    expect(screen.getByRole('alert').textContent).toBe('The org plugin is not loaded')
  })

  it('selects the first agent after the selected one is dismissed', async () => {
    const host = await showAgent(
      installHost(snapshotOf(), {
        Dismiss: (_payload, fake) => {
          fake.snapshot = snapshotOf({ hiredAgents: HIRES.filter((hire) => hire.id !== hireId(4)) })
          return { value: undefined }
        }
      }),
      /^Cy/
    )

    await click('Dismiss…')
    await click('Dismiss')

    await waitFor(() => expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Ada'))
    expect(host.sent).toEqual([['Dismiss', { hireId: hireId(4) }]])
  })

  it('offers neither the agent nor its reports as its manager', async () => {
    await showAgent(installHost(snapshotOf()), /^Ada/)

    await openSelect('Reports to')

    const popup = screen
      .getAllByRole('listbox', { hidden: true })
      .find((listbox) => listbox.getAttribute('aria-label') !== 'Hired agents')
    expect(
      within(popup as HTMLElement)
        .getAllByRole('option', { hidden: true })
        .map((option) => option.textContent)
    ).toEqual(['You', 'Cy'])
  })

  it('sends SetReportsTo for a new manager', async () => {
    const host = await showAgent(installHost(snapshotOf()), /^Cy/)

    await choose('Reports to', 'Ada')

    expect(host.sent).toEqual([['SetReportsTo', { hireId: hireId(4), reportsTo: hireId(1) }]])
  })

  it.each([
    ['itself', hireId(4), 'An agent cannot report to itself'],
    ['one of its reports', hireId(1), 'Ada already reports to Cy']
  ])('shows a cycle to %s under Reports to and keeps the saved value', async (_case, to, text) => {
    await showAgent(
      installHost(snapshotOf(), {
        SetReportsTo: failWith(ReportsToCycle.make({ hireId: hireId(4), reportsTo: to }))
      }),
      /^Cy/
    )

    await choose('Reports to', 'Ada')

    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Reports to' }).textContent).toMatch(/^You/)
  })

  it('shows The selected manager was dismissed and reads again', async () => {
    const host = await showAgent(
      installHost(snapshotOf(), {
        SetReportsTo: failWith(HireNotFound.make({ hireId: hireId(1) }))
      }),
      /^Cy/
    )
    const readsBefore = host.reads()

    await choose('Reports to', 'Ada')

    expect([screen.getByText('The selected manager was dismissed'), host.reads()]).toEqual([
      expect.anything(),
      readsBefore + 1
    ])
  })

  it('sends the bypass override', async () => {
    const host = await showAgent(installHost(snapshotOf()), /^Cy/)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'On' }))
    })

    expect(host.sent).toEqual([['SetBypassOverride', { hireId: hireId(4), override: true }]])
  })

  it('shows an error toast when the bypass override fails', async () => {
    await showAgent(
      installHost(snapshotOf(), {
        SetBypassOverride: notLoaded
      }),
      /^Cy/
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    })

    expect(vi.mocked(toast.add).mock.calls[0]?.[0]).toMatchObject({
      title: 'Could not change bypass approvals for Cy'
    })
  })

  it('hides the bypass override when bypass is unavailable', async () => {
    await showAgent(installHost(snapshotOf({ bypassAvailable: false })), /^Cy/)

    expect(screen.queryByRole('group', { name: 'Bypass approvals' })).toBeNull()
  })

  it('opens the Hire dialog from Hire… above the list', async () => {
    await renderOrg(installHost(snapshotOf()))
    await go('Hired agents')

    await click('Hire…')

    expect(screen.getByRole('dialog', { name: 'Hire an agent' })).toBeTruthy()
  })
})

describe('Objectives', () => {
  const openObjectives = async (host: FakeHost) => {
    await renderOrg(host)
    await go('Objectives')
    await screen.findByRole('heading', { level: 3 })
    return host
  }

  const facts = () =>
    Object.fromEntries(
      [...document.querySelectorAll('dl > div')].map((row) => [
        row.querySelector('dt')?.textContent,
        row.querySelector('dd')?.textContent
      ])
    )

  const detailTitle = () => screen.getByRole('heading', { level: 3 }).textContent

  const issueRow = (title: string) => screen.getByRole('listitem', { name: title })

  const selectObjective = (title: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${title}`) }))
    })

  const create = () =>
    act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create' }))
    })

  it('lists open objectives by priority with their project, and completed ones last', async () => {
    await openObjectives(installHost(snapshotOf()))

    const rows = within(screen.getByRole('listbox', { name: 'Objectives' })).getAllByRole('option')

    expect(rows.map((row) => row.textContent)).toEqual([
      'Ship the objective screendia',
      'Tidy release noteswebsite',
      'Move settings to SQLitedia'
    ])
  })

  it('shows the high-priority objective first, with its facts', async () => {
    await openObjectives(installHost(snapshotOf()))

    expect(detailTitle()).toBe('Ship the objective screen')
    expect(facts()).toEqual({
      Project: 'dia',
      Priority: 'High',
      State: 'Open',
      Assignee: 'Ada',
      Description: 'List objectives beside a detail, and show every issue with its status.'
    })
  })

  it('shows Unassigned and No description for an objective with neither', async () => {
    await openObjectives(installHost(snapshotOf()))

    await selectObjective('Tidy release notes')

    expect(detailTitle()).toBe('Tidy release notes')
    expect(facts()).toEqual({
      Project: 'website',
      Priority: 'Normal',
      State: 'Open',
      Assignee: 'Unassigned',
      Description: 'No description'
    })
  })

  it('shows a completed objective as Completed, without Add issue', async () => {
    await openObjectives(installHost(snapshotOf()))

    await selectObjective('Move settings to SQLite')

    expect(facts().State).toBe('Completed')
    expect(screen.queryByRole('button', { name: 'Add issue' })).toBeNull()
  })

  it('shows the empty state when there are no objectives', async () => {
    await renderOrg(
      installHost(snapshotOf(), {}, { ...WORK, objectives: [], issues: [], comments: [] })
    )
    await go('Objectives')

    expect(await screen.findByText('No objectives yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New objective…' })).toBeTruthy()
  })

  it('says the host entry is not loaded when it is not serving WatchWork', async () => {
    const host = installHost(snapshotOf())
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
            error: { _tag: 'PluginNotServing', plugin: 'org', tag, message: 'not loaded' }
          })
        )
        return () => {}
      }
    })
    await renderOrg(host)
    await go('Objectives')

    expect(await screen.findByText("The org plugin's host entry is not loaded.")).toBeTruthy()
  })

  it('nests a sub-issue under its parent and a marked retro issue under the issue it reviews', async () => {
    await openObjectives(installHost(snapshotOf()))

    expect(
      within(issueRow('Build the objective screen')).queryByText('Test the issue tree')
    ).not.toBeNull()
    expect(
      within(issueRow('Stream the work view')).queryByText('Retro: Stream the work view')
    ).not.toBeNull()
    expect(within(issueRow('Retro: Stream the work view')).queryByText('Retro')).not.toBeNull()
    expect(within(issueRow('Build the objective screen')).queryByText('Retro')).toBeNull()
    expect(
      within(issueRow('Build the objective screen')).queryByText('Write the release note')
    ).toBeNull()
  })

  it('marks the planning issue as Planning', async () => {
    await openObjectives(installHost(snapshotOf()))

    expect(
      within(issueRow('Plan: Ship the objective screen')).queryByText('Planning')
    ).not.toBeNull()
  })

  it.each([
    ['Add keyboard shortcuts', 'Triage'],
    ['Write the release note', 'Todo'],
    ['Build the objective screen', 'Implementing'],
    ['Show the status labels', 'In Review'],
    ['Stream the work view', 'Done'],
    ['Export objectives as CSV', 'Canceled']
  ])('labels %s with its status %s', async (title, label) => {
    await openObjectives(installHost(snapshotOf()))

    expect(within(issueRow(title)).queryByText(label)).not.toBeNull()
  })

  it('shows an issue status the host pushes without any user action', async () => {
    const host = await openObjectives(installHost(snapshotOf()))
    const before = within(issueRow('Write the release note')).queryByText('Implementing')

    await act(async () => {
      host.push({
        ...WORK,
        issues: WORK.issues.map((existing) =>
          existing.id === issueId(6) ? { ...existing, status: 'implementing' as const } : existing
        )
      })
    })

    expect(before).toBeNull()
    expect(within(issueRow('Write the release note')).queryByText('Implementing')).not.toBeNull()
  })

  it('sends AssignIssue when a todo issue gets an assignee', async () => {
    const host = await openObjectives(installHost(snapshotOf()))

    await choose('Assignee of Write the release note', 'Bea')

    await waitFor(() =>
      expect(host.sent).toContainEqual(['AssignIssue', { issueId: issueId(6), hireId: hireId(2) }])
    )
  })

  it('enables the assignee of triage and todo issues only', async () => {
    await openObjectives(installHost(snapshotOf()))

    const disabled = (title: string) =>
      screen.getByRole('combobox', { name: `Assignee of ${title}` }).hasAttribute('disabled')

    expect(
      [
        'Add keyboard shortcuts',
        'Write the release note',
        'Build the objective screen',
        'Show the status labels',
        'Stream the work view'
      ].map(disabled)
    ).toEqual([false, false, true, true, true])
  })

  it('offers Finish on every started issue, and sends FinishIssue from it', async () => {
    const host = await openObjectives(installHost(snapshotOf()))
    const finishes = screen
      .getAllByRole('button', { name: 'Finish' })
      .map((button) => button.closest('li')?.getAttribute('aria-label'))

    await act(async () => {
      fireEvent.click(
        within(issueRow('Build the objective screen')).getByRole('button', { name: 'Finish' })
      )
    })

    expect(finishes).toEqual(['Build the objective screen', 'Show the status labels'])
    await waitFor(() => expect(host.sent).toContainEqual(['FinishIssue', { issueId: issueId(2) }]))
  })

  const press = (name: string, scope?: HTMLElement) =>
    act(async () => {
      fireEvent.click((scope ? within(scope) : screen).getByRole('button', { name }))
    })

  it.each([
    ['Accept', 'accept', 'Todo'],
    ['Decline', 'decline', 'Canceled']
  ])(
    'sends TriageIssues from %s on a triage issue and the issue moves',
    async (name, decision, label) => {
      const host = await openObjectives(installHost(snapshotOf()))

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
    await openObjectives(installHost(snapshotOf()))

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
    const host = await openObjectives(installHost(snapshotOf()))

    await press(name)

    await waitFor(() =>
      expect(host.sent).toContainEqual([
        'TriageIssues',
        { issueIds: [issueId(7), issueId(8)], decision }
      ])
    )
  })

  it('counts the triage issues in the bar, singular for one', async () => {
    const host = await openObjectives(installHost(snapshotOf()))
    const before = screen.queryByText('2 issues in Triage')

    await press('Accept', issueRow('Add keyboard shortcuts'))

    expect(before).not.toBeNull()
    expect(await screen.findByText('1 issue in Triage')).toBeTruthy()
    expect(host.sent).toHaveLength(1)
  })

  it('hides the Triage bar when no issue is in triage', async () => {
    await openObjectives(installHost(snapshotOf()))

    await press('Accept all')

    await waitFor(() => expect(screen.queryByText(/in Triage$/)).toBeNull())
    expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull()
  })

  it('shows the first line of an issue description and none for an empty one', async () => {
    await openObjectives(installHost(snapshotOf()))

    expect(
      within(issueRow('Build the objective screen')).queryByText(
        'A list of objectives beside the selected one.'
      )
    ).not.toBeNull()
    expect(within(issueRow('Build the objective screen')).queryByText(/Show its issues/)).toBeNull()
  })

  it('shows a comment under its issue with its author, and Dismissed agent for a null author', async () => {
    await openObjectives(installHost(snapshotOf()))

    const commentOf = (body: string) => within(screen.getByText(body).closest('li') as HTMLElement)

    const bea = commentOf('The tree nests sub-issues under their parent.')
    const dismissed = commentOf('Ready for review.')

    expect(bea.getByText('Bea')).toBeTruthy()
    expect(dismissed.getByText('Dismissed agent')).toBeTruthy()
    expect(
      issueRow('Build the objective screen').contains(screen.getByText('Ready for review.'))
    ).toBe(false)
  })

  it('toasts why accepting an issue failed when it is no longer in Triage', async () => {
    await openObjectives(
      installHost(snapshotOf(), {
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

  it('toasts why declining all failed', async () => {
    await openObjectives(
      installHost(snapshotOf(), {
        TriageIssues: failWith(IssueNotInTriage.make({ issueId: issueId(7), status: 'done' }))
      })
    )

    await press('Decline all')

    expect(vi.mocked(toast.add).mock.calls[0]?.[0]).toMatchObject({
      title: 'Could not decline the issues',
      description: 'This issue is no longer in Triage'
    })
  })

  it('sends CreateIssue with an empty description from Add issue and shows the new issue', async () => {
    const host = await openObjectives(installHost(snapshotOf()))

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
        assignee: hireId(4)
      }
    })
    expect(await screen.findByRole('listitem', { name: 'Review the screen' })).toBeTruthy()
  })

  it('rejects an empty issue title without a call', async () => {
    const host = await openObjectives(installHost(snapshotOf()))

    await click('Add issue')

    expect(screen.getByRole('alert').textContent).toBe('Enter a title')
    expect(sentTags(host)).not.toContain('CreateIssue')
  })

  it('offers only the registered projects', async () => {
    await openObjectives(installHost(snapshotOf()))
    await click('New objective…')

    await openSelect('Project')

    const projectOptions = screen
      .getAllByRole('option', { hidden: true })
      .filter((option) => option.closest('[aria-label="Objectives"]') === null)
    expect(projectOptions.map((option) => option.textContent)).toEqual(
      PROJECTS.map((project) => project.name)
    )
  })

  it('sends CreateObjective with the form and selects the new objective', async () => {
    const host = await openObjectives(installHost(snapshotOf()))
    await click('New objective…')

    await choose('Project', 'website')
    type('Title', '  Launch the docs site  ')
    type('Description', 'Write the getting started guide.')
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'High' }))
    })
    await choose('Assignee', 'Ada')
    await create()

    const [, payload] = host.sent.find(([tag]) => tag === 'CreateObjective') ?? []
    expect(payload).toEqual({
      objective: {
        id: expect.any(String),
        projectId: PROJECTS[1].id,
        title: 'Launch the docs site',
        description: 'Write the getting started guide.',
        priority: 'high',
        assignee: hireId(1)
      }
    })
    await waitFor(() => expect(detailTitle()).toBe('Launch the docs site'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([
    ['an empty title', '   ', 'Enter a title'],
    ['a 121-character title', 'x'.repeat(121), 'Use at most 120 characters']
  ])('rejects %s without a call', async (_case, title, message) => {
    const host = await openObjectives(installHost(snapshotOf()))
    await click('New objective…')

    type('Title', title)
    await create()

    expect(within(screen.getByRole('dialog')).getByText(message)).toBeTruthy()
    expect(sentTags(host)).not.toContain('CreateObjective')
  })

  it('accepts a 120-character title', async () => {
    const host = await openObjectives(installHost(snapshotOf()))
    await click('New objective…')

    type('Title', 'x'.repeat(120))
    await create()

    await waitFor(() => expect(sentTags(host)).toContain('CreateObjective'))
  })
})

describe('Hire dialog', () => {
  const NEW_HIRE = HiredAgent.make({
    id: hireId(9),
    jobTitleId: REVIEWER.id,
    name: null,
    bypassOverride: null,
    reportsTo: hireId(1),
    hiredAt: Date.UTC(2026, 10, 9)
  })

  const openHire = async (host: FakeHost) => {
    await renderOrg(host)
    await go('Hired agents')
    await click('Hire…')
    return host
  }

  it('keeps Hire disabled until a job title is chosen', async () => {
    await openHire(installHost(snapshotOf()))
    const hire = () => screen.getByRole('button', { name: /^Hire$/ }) as HTMLButtonElement
    const before = hire().disabled

    await choose('Job title', 'Reviewer')

    expect([before, hire().disabled]).toEqual([true, false])
  })

  it('sends a blank name as null and the chosen manager, then shows the new agent', async () => {
    const host = await openHire(
      installHost(snapshotOf(), {
        Hire: (_payload, fake) => {
          fake.snapshot = snapshotOf({ hiredAgents: [...HIRES, NEW_HIRE] })
          return { value: NEW_HIRE }
        }
      })
    )

    await choose('Job title', 'Reviewer')
    await choose('Reports to', 'Ada')
    await click(/^Hire$/)

    expect(host.sent).toEqual([
      ['Hire', { jobTitleId: REVIEWER.id, name: null, reportsTo: hireId(1) }]
    ])
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Unnamed Reviewer')
    )
  })

  it('shows JobTitleDisabled under the Hire button', async () => {
    await openHire(
      installHost(snapshotOf(), {
        Hire: failWith(JobTitleDisabled.make({ jobTitleId: REVIEWER.id }))
      })
    )

    await choose('Job title', 'Reviewer')
    await click(/^Hire$/)

    expect(screen.getByRole('alert').textContent).toBe('This job title is disabled')
  })

  it('fixes the job title when opened from a job title', async () => {
    await renderOrg(installHost(snapshotOf()))
    await go('Job titles')
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /^Team lead/ }))
    })

    await click('Hire…')

    const dialog = screen.getByRole('dialog', { name: 'Hire an agent' })
    expect(within(dialog).queryByRole('combobox', { name: 'Job title' })).toBeNull()
    expect(within(dialog).getByText(TEAM_LEAD.name)).toBeTruthy()
  })
})

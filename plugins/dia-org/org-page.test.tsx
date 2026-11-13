// @vitest-environment jsdom
// @effect-diagnostics newPromise:off -- the skeleton test holds the read open with a Promise that never resolves.
import { AgentName, type PluginServices, type PluginSetup } from '@dia/plugin'
import { callHost, followHost, openSettings, toast } from '@dia/renderer-plugin'
import { McpServerPickerKey, type McpServerPickerProps } from '@dia-plugin/dia-mcp/picker'
import { SkillPickerKey, type SkillPickerProps } from '@dia-plugin/dia-skills/picker'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Atom } from 'effect/reactivity'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import { type OrgLive, ReadOrg, WatchOrgLive } from './calls'
import {
  HiredAgent,
  HireHasOpenIssues,
  HireNameTaken,
  HireNotFound,
  IssuesNotLoaded,
  JobTitleDisabled,
  JobTitleHasHires,
  JobTitleNameTaken,
  JobTitleNotFound,
  ReportsToCycle
} from './domain'
import { OnboardingStrip } from './onboarding'
import {
  ASSISTANT_RUN,
  type FakeHost,
  HIRES,
  hireId,
  installHost,
  JOB_TITLES,
  jobTitleNamed,
  type Reply,
  snapshotOf
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
const StubMcpServerPicker = ({ label, value, onChange }: McpServerPickerProps) => (
  <button type="button" aria-label={label} onClick={() => onChange([...value, 'github'])}>
    {value.join(',')}
  </button>
)

const StubSkillPicker = ({ label, value, onChange }: SkillPickerProps) => (
  <button type="button" aria-label={label} onClick={() => onChange([...value, 'review'])}>
    {value.join(',')}
  </button>
)

const mcp: PluginSetup<PluginServices> = (services) =>
  services.provide(McpServerPickerKey, StubMcpServerPicker)

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
    <OrgPage ctx={ctx} orgAtom={orgAtom} liveAtom={Atom.make(followHost(ctx, WatchOrgLive, {}))} />
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

const choose = async (select: string, option: string | RegExp) => {
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

  it.each(['Org chart', 'Job titles', 'Hired agents', 'Dashboard'])(
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
        liveAtom={Atom.make(followHost(ctx, WatchOrgLive, {}))}
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
        liveAtom={Atom.make(followHost(ctx, WatchOrgLive, {}))}
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

    expect(vi.mocked(openSettings).mock.calls).toEqual([[{ plugin: 'dia-org', id: 'org' }]])
  })
})

describe('Dashboard onboarding', () => {
  const live = (overrides: Partial<OrgLive> = {}): OrgLive => ({
    assistantEnabled: true,
    assistantRunId: null,
    teamHasWork: false,
    ...overrides
  })

  const steps = () =>
    within(screen.getByRole('region', { name: 'Set up the org' }))
      .getAllByRole('listitem')
      .map((step) => [
        step.querySelector('[data-slot="status-name"]')?.textContent,
        step.getAttribute('aria-current')
      ])

  const currentStep = () => steps().find(([, state]) => state === 'step')?.[0]

  it('draws the steps before the current one done and holds Add project… at Add a project', () => {
    render(<OnboardingStrip stage="add-project" openStaff={() => {}} />)

    expect([steps(), screen.queryByRole('button', { name: 'Add project…' }) !== null]).toEqual([
      [
        ['Add a project', 'step'],
        ['Staff the org', null],
        ['Get the team working', null]
      ],
      true
    ])
  })

  it('draws the steps before Get the team working done', () => {
    render(<OnboardingStrip stage="get-working" openStaff={() => {}} />)

    const fills = within(screen.getByRole('region', { name: 'Set up the org' }))
      .getAllByRole('listitem')
      .map((step) =>
        step.querySelector('[data-slot="status-media"]')?.className.includes('bg-current')
      )
    expect(fills).toEqual([true, true, false])
  })

  it('marks Staff the org current with a project and no hire; its button opens the dialog', async () => {
    await renderOrg(installHost(snapshotOf({ hiredAgents: [] }), {}, live()))
    const current = currentStep()

    await click('Staff the org…')

    expect(current).toBe('Staff the org')
    expect(screen.getByRole('dialog', { name: 'Staff the org' })).toBeTruthy()
  })

  it('marks Get the team working current while no hire has work, with the request box', async () => {
    await renderOrg(installHost(snapshotOf(), {}, live()))

    expect(currentStep()).toBe('Get the team working')
    expect(screen.getByLabelText('What should the team work on?')).toBeTruthy()
  })

  it('sends the trimmed request to the Executive assistant and shows its run in a tab', async () => {
    const host = installHost(snapshotOf(), {}, live())
    await renderOrg(host)

    type('What should the team work on?', '  Add a dark mode toggle  ')
    await click('Send to the Executive assistant')

    await waitFor(() =>
      expect(host.sent).toEqual([
        ['AskAssistant', { text: 'Add a dark mode toggle' }],
        ['OpenRunInTab', { runId: ASSISTANT_RUN }]
      ])
    )
  })

  it('archives the Executive assistant run on Start over', async () => {
    const host = installHost(snapshotOf(), {}, live({ assistantRunId: ASSISTANT_RUN }))
    await renderOrg(host)

    await click('Start over')

    await waitFor(() => expect(host.sent).toEqual([['StartOverAssistant', {}]]))
  })

  it('keeps Send disabled while the request is blank', async () => {
    await renderOrg(installHost(snapshotOf(), {}, live()))

    type('What should the team work on?', '   ')

    const send = screen.getByRole('button', { name: 'Send to the Executive assistant' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers no request box while the Executive assistant job title is disabled', async () => {
    await renderOrg(installHost(snapshotOf(), {}, live({ assistantEnabled: false })))

    expect([
      screen.queryByText(
        'The Executive assistant job title is disabled, so it cannot take requests.'
      ) !== null,
      screen.queryByLabelText('What should the team work on?')
    ]).toEqual([true, null])
  })

  it('shows no onboarding once a hire has an open issue', async () => {
    await renderOrg(installHost(snapshotOf(), {}, live({ teamHasWork: true })))

    expect(screen.queryByRole('region', { name: 'Set up the org' })).toBeNull()
  })

  it('removes the onboarding when the team gets work while the Dashboard is shown', async () => {
    const host = installHost(snapshotOf(), {}, live())
    await renderOrg(host)
    const before = screen.queryByRole('region', { name: 'Set up the org' }) !== null

    await act(async () => host.push(live({ teamHasWork: true })))

    expect([before, screen.queryByRole('region', { name: 'Set up the org' })]).toEqual([true, null])
  })
})

describe('Staff the org dialog', () => {
  const ENGINEER = jobTitleNamed('Software engineer')
  const TESTER = jobTitleNamed('Quality engineer')

  const openStaff = async (host: FakeHost) => {
    await renderOrg(host)
    await click('Staff the org…')
    return host
  }

  const noHires = (
    replies: Record<string, (payload: Record<string, unknown>, host: FakeHost) => Reply> = {}
  ) => installHost(snapshotOf({ hiredAgents: [] }), replies)

  const hired = (n: number, jobTitleId: HiredAgent['jobTitleId'], reportsTo: number | null) =>
    HiredAgent.make({
      id: hireId(n),
      jobTitleId,
      name: null,
      bypassOverride: null,
      reportsTo: reportsTo === null ? null : hireId(reportsTo),
      hiredAt: Date.UTC(2026, 10, n)
    })

  const count = (jobTitle: string) =>
    screen.getByRole('status', { name: `${jobTitle} count` }).textContent

  it('starts on Feature team: a Team lead, two Software engineers and a Quality engineer', async () => {
    await openStaff(noHires())

    expect([
      within(screen.getByRole('combobox', { name: 'Lead' })).queryByText('Team lead') !== null,
      count('Software engineer'),
      count('Quality engineer'),
      count('Reviewer'),
      screen.queryByRole('button', { name: 'Hire 4 agents' }) !== null
    ]).toEqual([true, '2', '1', '0', true])
  })

  it('sends the lead and one member id per count in StaffTeam, then closes', async () => {
    const team = [
      hired(5, TEAM_LEAD.id, null),
      hired(6, ENGINEER.id, 5),
      hired(7, ENGINEER.id, 5),
      hired(8, TESTER.id, 5)
    ]
    const host = await openStaff(
      noHires({
        StaffTeam: (_payload, fake) => {
          fake.snapshot = snapshotOf({ hiredAgents: team })
          return { value: team }
        }
      })
    )

    await click('Hire 4 agents')

    expect(host.sent).toEqual([
      [
        'StaffTeam',
        { plan: { lead: TEAM_LEAD.id, members: [ENGINEER.id, ENGINEER.id, TESTER.id] } }
      ]
    ])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('adds a member with More to the count and the button', async () => {
    await openStaff(noHires())

    await click('More Reviewer')

    expect([
      count('Reviewer'),
      screen.queryByRole('button', { name: 'Hire 5 agents' }) !== null
    ]).toEqual(['1', true])
  })

  it('disables Hire with no lead and every count at 0', async () => {
    await openStaff(noHires())

    await choose('Lead', 'No lead')
    await click('Fewer Software engineer')
    await click('Fewer Software engineer')
    await click('Fewer Quality engineer')

    const hire = screen.getByRole('button', { name: /^Hire$/ }) as HTMLButtonElement
    expect(hire.disabled).toBe(true)
  })

  it('shows the hire failure and keeps the dialog open', async () => {
    await openStaff(
      noHires({ StaffTeam: failWith(JobTitleDisabled.make({ jobTitleId: TESTER.id })) })
    )

    await click('Hire 4 agents')

    expect([
      screen.getByRole('alert').textContent,
      screen.queryByRole('dialog', { name: 'Staff the org' }) !== null
    ]).toEqual(['This job title is disabled', true])
  })

  it('offers no preset whose lead job title is disabled', async () => {
    const titles = JOB_TITLES.map((jobTitle) =>
      jobTitle.id === TEAM_LEAD.id ? { ...jobTitle, enabled: false } : jobTitle
    )
    await openStaff(installHost(snapshotOf({ jobTitles: titles, hiredAgents: [] })))

    const presets = within(screen.getByRole('group', { name: 'Team preset' }))
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(presets).toEqual(['Product team', 'Solo engineer'])
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

  it('saves a skill chosen in the provided skill picker as the skills list', async () => {
    await startRendererRegistry({
      mcp,
      skills: (services) => services.provide(SkillPickerKey, StubSkillPicker)
    })
    const host = installHost(snapshotOf())
    await showReviewer(host)

    await click('Skills')
    await click('Save')

    expect(host.sent).toEqual([
      [
        'EditJobTitle',
        { jobTitleId: REVIEWER.id, edit: { skills: [...REVIEWER.skills, 'review'] } }
      ]
    ])
  })

  it('saves a server chosen in the provided MCP server picker as the server names', async () => {
    const host = installHost(snapshotOf())
    await showReviewer(host)

    await click('MCP servers')
    await click('Save')

    expect(host.sent).toEqual([
      ['EditJobTitle', { jobTitleId: REVIEWER.id, edit: { mcpServers: ['github'] } }]
    ])
  })

  it('saves MCP server names typed one per line while mcp is not loaded', async () => {
    await startRendererRegistry({})
    const host = installHost(snapshotOf())
    await showReviewer(host)

    type('MCP servers', 'github\nlinear\n')
    await click('Save')

    expect(host.sent).toEqual([
      ['EditJobTitle', { jobTitleId: REVIEWER.id, edit: { mcpServers: ['github', 'linear'] } }]
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

  it('says how many open issues stop a dismiss', async () => {
    await showAgent(
      installHost(snapshotOf(), {
        Dismiss: failWith(HireHasOpenIssues.make({ hireId: hireId(4), issues: 2 }))
      }),
      /^Cy/
    )

    await click('Dismiss…')
    await click('Dismiss')

    expect(screen.getByRole('alert').textContent).toBe(
      'Cy is assigned to 2 open issues; assign them to someone else first'
    )
  })

  it('says a dismiss waits for issues while it is not loaded', async () => {
    await showAgent(
      installHost(snapshotOf(), { Dismiss: failWith(IssuesNotLoaded.make({})) }),
      /^Cy/
    )

    await click('Dismiss…')
    await click('Dismiss')

    expect(screen.getByRole('alert').textContent).toBe(
      'Issues is not ready; it cannot be checked whether this agent has open issues'
    )
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

    await choose('Job title', /^Reviewer/)

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

    await choose('Job title', /^Reviewer/)
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

    await choose('Job title', /^Reviewer/)
    await click(/^Hire$/)

    expect(screen.getByRole('alert').textContent).toBe('This job title is disabled')
  })

  it('shows the first line of each job description under its name, and the name alone once chosen', async () => {
    const firstLine = 'Reviews every change for correctness. '.repeat(13).trim()
    const long = `${firstLine}\nSecond line.`
    const titles = JOB_TITLES.map((jobTitle) =>
      jobTitle.id === REVIEWER.id ? { ...jobTitle, jobDescription: long } : jobTitle
    )
    await openHire(installHost(snapshotOf({ jobTitles: titles })))
    await choose('Job title', /^Reviewer/)
    await openSelect('Job title')
    const option = screen.getByRole('option', { name: /^Reviewer/, hidden: true })
    const summary = option.querySelector('.truncate.text-xs')?.textContent
    await openSelect('Job title')

    expect([summary, screen.getByRole('combobox', { name: 'Job title' }).textContent]).toEqual([
      firstLine,
      expect.stringMatching(/^Reviewer/)
    ])
    expect(screen.getByRole('combobox', { name: 'Job title' }).textContent).not.toContain(
      'Reviews every change'
    )
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

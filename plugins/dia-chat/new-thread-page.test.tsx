// @vitest-environment jsdom

import type { Draft, ThreadTarget } from '@dia/renderer-plugin'
import type { ThreadTargetEntry } from '@dia-plugin/dia-chat/slots'
import type { ModelOption } from '@shared/domain/model'
import { EMPTY_ADAPTER_PREFERENCES } from '@shared/domain/model-preferences'
import { ProjectId, type Workspace } from '@shared/domain/project'
import { Uuid } from '@shared/domain/uuid'
import type { ListEntry } from '@shared/plugin/list-slot'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DateTime, Effect } from 'effect'
import { SparklesIcon } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewThreadPage as Page, startingModel } from './new-thread-page'

const slashCommandsFor = vi.hoisted(() => vi.fn())

vi.mock('./hooks/use-slash-commands', () => ({ useSlashCommands: slashCommandsFor }))

const NewThreadPage = ({ draftId }: { readonly draftId: Uuid }) => (
  <QueryClientProvider client={new QueryClient()}>
    <Page draftId={draftId} />
  </QueryClientProvider>
)

const DRAFT = Uuid.make('00000000-0000-4000-8000-0000000000d1')
const PROJECT = ProjectId.make('00000000-0000-4000-8000-000000000001')
const SONNET = 'claude-sonnet-5-5'

const model = (value: string): ModelOption => ({
  value,
  displayName: value,
  description: '',
  adaptiveThinking: true,
  effortLevels: [],
  autoMode: true,
  fastMode: false
})

const state = vi.hoisted(() => ({
  workspace: undefined as Workspace | undefined,
  drafts: [] as Array<Draft>,
  entries: [] as Array<unknown>,
  completed: [] as Array<[string, unknown]>
}))

vi.mock('@dia/renderer-plugin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dia/renderer-plugin')>()
  return {
    ...original,
    useWorkspace: () => state.workspace,
    useDrafts: () => state.drafts,
    useList: () => state.entries,
    useRunSummaries: () => new Map(),
    useModelCatalog: () => ({
      state: {
        _tag: 'Ready',
        models: [model('claude-sonnet-5-5')],
        fetchedAt: DateTime.makeUnsafe(0),
        refreshing: false
      },
      refresh: () => {}
    }),
    useModelPreferences: () => ({ models: {}, defaults: {} }),
    useAdapterStatus: () => undefined,
    usePluginList: () => ({ plugins: [] }),
    useDisabledPermissionModes: () => [],
    useAttachmentTypes: () => [],
    actions: {
      ...original.actions,
      defaultThreadTarget: () => null,
      saveDraft: (draft: Draft) => {
        state.drafts = [...state.drafts.filter((saved) => saved.draftId !== draft.draftId), draft]
      },
      completeDraft: (draftId: string, target: unknown) => {
        state.completed.push([draftId, target])
      }
    }
  }
})

const workspaceWith = (isGitRepo: boolean): Workspace => ({
  projects: [
    {
      project: {
        projectId: PROJECT,
        directory: '/repo',
        directoryKey: '/repo',
        displayName: 'atlas',
        isGitRepo
      },
      tabs: []
    }
  ],
  visibleTab: null
})

const draftFor = (target: ThreadTarget | null, text: string): Draft => ({
  draftId: DRAFT,
  target,
  text,
  model: null,
  thinkingLevel: null,
  permissionMode: null,
  worktree: null,
  sentAs: null
})

const assistant = (send: ThreadTargetEntry['send']): ListEntry<ThreadTargetEntry> => ({
  id: 'assistant',
  order: 10,
  label: 'Assistant',
  icon: SparklesIcon,
  send,
  key: { plugin: 'dia-org', id: 'assistant' }
})

let createTab: ReturnType<typeof vi.fn>
let failCreate: (event: { paneId: string; reason: string }) => void

beforeEach(() => {
  state.workspace = workspaceWith(false)
  state.drafts = []
  state.entries = []
  state.completed = []
  createTab = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  slashCommandsFor.mockReset()
  slashCommandsFor.mockReturnValue({ commands: [], loading: false })
  failCreate = () => {}
  Object.assign(window, {
    dia: {
      createTab,
      onPaneCreateFailed: (listener: typeof failCreate) => {
        failCreate = listener
        return () => {}
      },
      pathForFile: () => '',
      listProjectEntries: () => Promise.resolve([])
    }
  })
})

afterEach(cleanup)

const sendButton = () => screen.getByRole('button', { name: 'Send' })

describe('startingModel', () => {
  const models = [model('claude-haiku-5-5'), model(SONNET)]

  it('keeps the chosen model while the picker offers it', () => {
    expect(startingModel(models, EMPTY_ADAPTER_PREFERENCES, SONNET)).toBe(SONNET)
  })

  it("falls back to the adapter's default model when the chosen one is not offered", () => {
    const preferences = { models: {}, defaults: { model: SONNET } }

    expect(startingModel(models, preferences, 'claude-retired')).toBe(SONNET)
  })

  it('falls back to the first offered model when nothing else applies', () => {
    expect(startingModel(models, EMPTY_ADAPTER_PREFERENCES, null)).toBe('claude-haiku-5-5')
  })

  it('is undefined while no model is offered', () => {
    expect(startingModel([], EMPTY_ADAPTER_PREFERENCES, null)).toBeUndefined()
  })
})

describe('NewThreadPage for a project', () => {
  it('names the project in the headline', () => {
    state.drafts = [draftFor({ _tag: 'ProjectTarget', projectId: PROJECT }, '')]

    render(<NewThreadPage draftId={DRAFT} />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'What are we building today in atlas?'
    )
  })

  it('asks the Host to create the tab with the draft text as its first message', () => {
    state.drafts = [draftFor({ _tag: 'ProjectTarget', projectId: PROJECT }, '  Fix the login  ')]
    render(<NewThreadPage draftId={DRAFT} />)

    fireEvent.click(sendButton())

    const [request] = createTab.mock.calls[0] ?? []
    expect(request).toMatchObject({
      projectId: PROJECT,
      model: SONNET,
      worktree: null,
      firstMessage: { text: 'Fix the login', attachments: [] }
    })
    expect(state.drafts[0]?.sentAs).toBe(request.paneId)
  })

  it('keeps the draft and shows the reason when the Host cannot create the tab', async () => {
    state.drafts = [draftFor({ _tag: 'ProjectTarget', projectId: PROJECT }, 'Fix the login')]
    const { rerender } = render(<NewThreadPage draftId={DRAFT} />)
    fireEvent.click(sendButton())
    rerender(<NewThreadPage draftId={DRAFT} />)
    const paneId = state.drafts[0]?.sentAs ?? ''

    failCreate({ paneId, reason: 'The worktree directory already exists' })

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The worktree directory already exists'
    )
    expect(state.drafts.map((draft) => draft.text)).toEqual(['Fix the login'])
    expect(state.completed).toEqual([])
  })

  it('does not send an empty message', () => {
    state.drafts = [draftFor({ _tag: 'ProjectTarget', projectId: PROJECT }, '   ')]
    render(<NewThreadPage draftId={DRAFT} />)

    fireEvent.click(sendButton())

    expect(createTab).not.toHaveBeenCalled()
  })
})

describe('NewThreadPage for a plugin target', () => {
  const target: ThreadTarget = { _tag: 'PluginThreadTarget', plugin: 'dia-org', id: 'assistant' }

  it('hands the text to the target and completes the draft', async () => {
    const send = vi.fn((_text: string) => Effect.void)
    state.entries = [assistant(send)]
    state.drafts = [draftFor(target, 'Plan the release')]
    render(<NewThreadPage draftId={DRAFT} />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'What are we building today with the Assistant?'
    )
    fireEvent.click(sendButton())

    await waitFor(() => expect(state.completed).toEqual([[DRAFT, target]]))
    expect(send).toHaveBeenCalledWith('Plan the release')
    expect(createTab).not.toHaveBeenCalled()
  })

  it("shows the target's refusal and keeps the draft", async () => {
    state.entries = [assistant(() => Effect.fail('The Executive assistant job title is disabled.'))]
    state.drafts = [draftFor(target, 'Plan the release')]
    render(<NewThreadPage draftId={DRAFT} />)

    fireEvent.click(sendButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The Executive assistant job title is disabled.'
    )
    expect(state.completed).toEqual([])
  })
})

describe('NewThreadPage with nowhere to start', () => {
  it('offers to add a project and disables the composer', () => {
    state.workspace = { projects: [], visibleTab: null }

    render(<NewThreadPage draftId={DRAFT} />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'What are we building today?'
    )
    expect(screen.getByRole('button', { name: 'Add a project…' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Message dia' }).hasAttribute('disabled')).toBe(
      true
    )
  })
})

describe('NewThreadPage command completion', () => {
  const review = { name: 'review', description: 'Review the diff', argumentHint: '', aliases: [] }

  it('reads commands for the selected project directory', () => {
    state.drafts = [draftFor({ _tag: 'ProjectTarget', projectId: PROJECT }, '')]

    render(<NewThreadPage draftId={DRAFT} />)

    expect(slashCommandsFor).toHaveBeenCalledWith('/repo')
  })

  it('reads no commands for a plugin target', () => {
    state.entries = [assistant(() => Effect.void)]
    state.drafts = [
      draftFor({ _tag: 'PluginThreadTarget', plugin: 'dia-org', id: 'assistant' }, '')
    ]

    render(<NewThreadPage draftId={DRAFT} />)

    expect(slashCommandsFor).toHaveBeenCalledWith(null)
  })

  it('shows Loading commands… while the project commands load', () => {
    slashCommandsFor.mockReturnValue({ commands: [], loading: true })
    state.drafts = [draftFor({ _tag: 'ProjectTarget', projectId: PROJECT }, '')]

    render(<NewThreadPage draftId={DRAFT} />)

    expect(screen.getByText('Loading commands…')).toBeTruthy()
  })

  it('completes the highlighted command on Enter without sending', () => {
    slashCommandsFor.mockReturnValue({ commands: [review], loading: false })
    state.drafts = [draftFor({ _tag: 'ProjectTarget', projectId: PROJECT }, '/re')]
    render(<NewThreadPage draftId={DRAFT} />)
    const input = screen.getByRole('combobox', { name: 'Message dia' }) as HTMLTextAreaElement
    input.setSelectionRange(3, 3)
    fireEvent.select(input)

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(state.drafts[0]?.text).toBe('/review ')
    expect(createTab).not.toHaveBeenCalled()
  })
})

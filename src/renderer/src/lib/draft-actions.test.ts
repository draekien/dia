// @vitest-environment jsdom
import { AgentName, ProjectId, type Workspace } from '@shared/domain/project'
import { Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeDraft, defaultThreadTarget, discardDraft, newThread, saveDraft } from './actions'
import { draftsAtom, emptyDraft, lastTargetAtom, PluginThreadTarget, ProjectTarget } from './drafts'
import { appRegistry, newThreadFormAtom, workspaceAtom } from './workspace-atoms'

const PROJECT_A = ProjectId.make('00000000-0000-4000-8000-000000000001')
const PROJECT_B = ProjectId.make('00000000-0000-4000-8000-000000000002')
const PANE_B = '00000000-0000-4000-8000-00000000000b'
const ASSISTANT = PluginThreadTarget.make({ plugin: 'dia-org', id: 'assistant' })

const project = (projectId: ProjectId, directory: string) => ({
  projectId,
  directory,
  directoryKey: directory,
  displayName: directory.slice(1),
  isGitRepo: true
})

const workspace = (visibleTab: string | null): Workspace => ({
  projects: [
    { project: project(PROJECT_A, '/alpha'), tabs: [] },
    {
      project: project(PROJECT_B, '/beta'),
      tabs: [
        {
          name: AgentName.make('heron'),
          config: {
            paneId: PANE_B,
            cwd: '/beta',
            model: 'm',
            thinkingLevel: 'adaptive',
            permissionMode: 'default'
          },
          archived: false
        }
      ]
    }
  ],
  visibleTab
})

let pushWorkspace: (workspace: Workspace) => void = () => {}

const showWorkspace = async (value: Workspace) => {
  Object.assign(window, {
    dia: {
      selectTab,
      getWorkspace: () => Promise.resolve(value),
      onWorkspaceChanged: (listener: (event: { workspace: Workspace }) => void) => {
        pushWorkspace = (workspace) => listener({ workspace })
        return () => {}
      },
      onRunSummariesReplaced: () => () => {}
    }
  })
  await vi.waitFor(() => expect(Option.isSome(appRegistry.get(workspaceAtom))).toBe(true))
}

const openDraftId = () =>
  Option.getOrNull(Option.map(appRegistry.get(newThreadFormAtom), (form) => form.draftId))

let selectTab: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  selectTab = vi.fn()
  Object.assign(window, { dia: { selectTab } })
})

afterEach(() => {
  appRegistry.reset()
})

describe('defaultThreadTarget', () => {
  it("is the visible tab's project", async () => {
    await showWorkspace(workspace(PANE_B))
    appRegistry.set(lastTargetAtom, ASSISTANT)

    expect(defaultThreadTarget()).toEqual(ProjectTarget.make({ projectId: PROJECT_B }))
  })

  it('is the last sent target when no tab is visible', async () => {
    await showWorkspace(workspace(null))
    appRegistry.set(lastTargetAtom, ASSISTANT)

    expect(defaultThreadTarget()).toEqual(ASSISTANT)
  })

  it('is the first project when no tab is visible and nothing was sent', async () => {
    await showWorkspace(workspace(null))

    expect(defaultThreadTarget()).toEqual(ProjectTarget.make({ projectId: PROJECT_A }))
  })
})

describe('newThread', () => {
  it('saves an empty draft for the target and opens its page', async () => {
    await showWorkspace(workspace(PANE_B))

    newThread(ProjectTarget.make({ projectId: PROJECT_A }))

    const drafts = appRegistry.get(draftsAtom)
    expect(drafts.map((draft) => [draft.target, draft.text])).toEqual([
      [ProjectTarget.make({ projectId: PROJECT_A }), '']
    ])
    expect(openDraftId()).toBe(drafts[0]?.draftId)
    expect(selectTab).toHaveBeenCalledWith(null)
  })

  it("reuses the target's draft that has no text instead of saving another", async () => {
    await showWorkspace(workspace(null))
    newThread(ASSISTANT)
    const first = openDraftId()

    newThread(ASSISTANT)

    expect(appRegistry.get(draftsAtom)).toHaveLength(1)
    expect(openDraftId()).toBe(first)
  })

  it('saves a new draft when the target only has a draft with text', async () => {
    await showWorkspace(workspace(null))
    newThread(ASSISTANT)
    const [written] = appRegistry.get(draftsAtom)
    if (written !== undefined) saveDraft({ ...written, text: 'Plan the release' })

    newThread(ASSISTANT)

    expect(appRegistry.get(draftsAtom).map((draft) => draft.text)).toEqual(['Plan the release', ''])
  })
})

describe('drafts across a restart', () => {
  it('reads saved drafts back from storage', () => {
    const draft = { ...emptyDraft('00000000-0000-4000-8000-0000000000d1', ASSISTANT), text: 'hi' }
    saveDraft(draft)
    appRegistry.reset()

    expect(appRegistry.get(draftsAtom)).toEqual([draft])
  })

  it('reads no drafts from unreadable storage', () => {
    localStorage.setItem('dia.drafts', '{not json')

    expect(appRegistry.get(draftsAtom)).toEqual([])
  })
})

describe('discardDraft', () => {
  it('deletes the draft and returns to the tab its page opened over', async () => {
    await showWorkspace(workspace(PANE_B))
    newThread(ASSISTANT)
    const draftId = openDraftId()

    if (draftId !== null) discardDraft(draftId)

    expect(appRegistry.get(draftsAtom)).toEqual([])
    expect(openDraftId()).toBeNull()
    expect(selectTab).toHaveBeenLastCalledWith(PANE_B)
  })
})

describe('completeDraft', () => {
  it('deletes the draft and remembers its target as the last one sent', () => {
    const draft = emptyDraft('00000000-0000-4000-8000-0000000000d1', ASSISTANT)
    saveDraft(draft)

    completeDraft(draft.draftId, ASSISTANT)

    expect(appRegistry.get(draftsAtom)).toEqual([])
    expect(appRegistry.get(lastTargetAtom)).toEqual(ASSISTANT)
  })
})

describe('a sent draft', () => {
  it('is completed when the workspace gains the tab its Send created', async () => {
    await showWorkspace(workspace(null))
    const target = ProjectTarget.make({ projectId: PROJECT_B })
    saveDraft({ ...emptyDraft('00000000-0000-4000-8000-0000000000d1', target), sentAs: PANE_B })
    const unsent = { ...emptyDraft('00000000-0000-4000-8000-0000000000d2', ASSISTANT), text: 'hi' }
    saveDraft(unsent)

    pushWorkspace(workspace(PANE_B))

    await vi.waitFor(() => expect(appRegistry.get(draftsAtom)).toEqual([unsent]))
    expect(appRegistry.get(lastTargetAtom)).toEqual(target)
  })

  it('stays while the workspace has no tab for it', async () => {
    await showWorkspace(workspace(null))
    const draft = {
      ...emptyDraft('00000000-0000-4000-8000-0000000000d1', ASSISTANT),
      sentAs: '00000000-0000-4000-8000-0000000000ff'
    }
    saveDraft(draft)

    pushWorkspace(workspace(PANE_B))

    await vi.waitFor(() =>
      expect(Option.getOrNull(appRegistry.get(workspaceAtom))?.visibleTab).toBe(PANE_B)
    )
    expect(appRegistry.get(draftsAtom)).toEqual([draft])
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const DRAFT_ID = '00000000-0000-4000-8000-0000000000d1'

const savedDraft = (fields: Record<string, unknown>) => ({
  draftId: DRAFT_ID,
  target: null,
  text: 'Fix the login',
  thinkingLevel: null,
  permissionMode: null,
  worktree: null,
  sentAs: null,
  ...fields
})

afterEach(() => localStorage.clear())

const readDrafts = async () => {
  vi.resetModules()
  const { draftsAtom } = await import('./drafts')
  const { appRegistry } = await import('./workspace-atoms')
  return appRegistry.get(draftsAtom)
}

describe('saved drafts', () => {
  it('reads a draft saved with a model as a draft with no selection', async () => {
    localStorage.setItem('dia.drafts', JSON.stringify([savedDraft({ model: 'claude-sonnet-5-5' })]))

    const [draft] = await readDrafts()

    expect(draft?.selection).toBeNull()
  })

  it('keeps the selection of a draft saved with one', async () => {
    const selection = { backend: 'other-adapter', model: 'alpha' }
    localStorage.setItem('dia.drafts', JSON.stringify([savedDraft({ selection })]))

    const [draft] = await readDrafts()

    expect(draft?.selection).toEqual(selection)
  })
})

// @vitest-environment jsdom

import { PathAttachment, type ProjectEntry } from '@shared/domain/attachment'
import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerCompletion } from './composer-completion'

const commands: ReadonlyArray<SlashCommandInfo> = [
  { name: 'review', description: 'Review the diff', argumentHint: '', aliases: [] },
  { name: 'compact', description: 'Compact the thread', argumentHint: '', aliases: [] }
]
const entries: ReadonlyArray<ProjectEntry> = [
  { path: 'src', kind: 'directory' },
  { path: 'readme.md', kind: 'file' }
]

const listProjectEntries = vi.fn()

beforeEach(() => {
  listProjectEntries.mockReset()
  listProjectEntries.mockResolvedValue(entries)
  vi.stubGlobal('dia', { listProjectEntries })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Harness({
  initial,
  cwd,
  onPath
}: {
  readonly initial: string
  readonly cwd: string | null
  readonly onPath: (attachment: PathAttachment) => void
}) {
  const [text, setText] = useState(initial)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const completion = useComposerCompletion({
    text,
    setText,
    textareaRef,
    commands,
    cwd,
    listId: 'list',
    onPath
  })
  return (
    <div>
      <button type="button" onClick={() => setText('')}>
        reset
      </button>
      {completion.menu}
      <textarea
        ref={textareaRef}
        aria-label="composer"
        value={text}
        {...completion.textareaProps}
        onKeyDown={(event) => {
          completion.onKeyDown(event)
        }}
      />
    </div>
  )
}

const mount = (initial: string, cwd: string | null = '/repo', onPath = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness initial={initial} cwd={cwd} onPath={onPath} />
    </QueryClientProvider>
  )
  const input = screen.getByLabelText('composer') as HTMLTextAreaElement
  input.setSelectionRange(initial.length, initial.length)
  fireEvent.select(input)
  return { input, onPath }
}

describe('useComposerCompletion', () => {
  it('lists commands matching the typed slash token', () => {
    mount('/re')

    expect(screen.getAllByRole('option').map((option) => option.id)).toEqual([
      'list-slash-option-0'
    ])
  })

  it('completes the highlighted command on Enter', () => {
    const { input } = mount('/re')

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input.value).toBe('/review ')
  })

  it('closes the menu on Escape', () => {
    const { input } = mount('/re')

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes the menu when the text is reset from outside', () => {
    mount('/re')

    fireEvent.click(screen.getByText('reset'))

    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('hands a chosen path to onPath on Enter', async () => {
    const { input, onPath } = mount('@')
    await screen.findAllByRole('option')

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onPath).toHaveBeenCalledWith(
      PathAttachment.make({ path: '/repo/src', kind: 'directory' })
    )
    expect(input.value).toBe('')
  })

  it('reports the combobox as expanded while a menu is open', () => {
    const { input } = mount('/re')

    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('role')).toBe('combobox')
  })

  it('never opens the path menu without a cwd', async () => {
    mount('@', null)

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(listProjectEntries).not.toHaveBeenCalled()
  })
})

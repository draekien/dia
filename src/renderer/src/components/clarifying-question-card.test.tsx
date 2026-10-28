// @vitest-environment jsdom
import { PaneQuestionRequested } from '@shared/ipc/contract'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClarifyingQuestionCard } from './clarifying-question-card'

const SCOPE = 'Which scope?'
const PLACEMENT = 'Where should it live?'

const request = PaneQuestionRequested.make({
  paneId: '00000000-0000-4000-8000-000000000001',
  requestId: 'request-1',
  questions: [
    {
      question: SCOPE,
      header: 'Scope',
      options: [
        { label: 'Small', description: '' },
        { label: 'Large', description: '' }
      ],
      multiSelect: false
    },
    {
      question: PLACEMENT,
      header: 'Placement',
      options: [
        { label: 'Kernel', description: '' },
        { label: 'Plugin', description: '' }
      ],
      multiSelect: false
    }
  ]
})

function renderCard() {
  const onResolve = vi.fn()
  render(<ClarifyingQuestionCard request={request} onResolve={onResolve} />)
  return { onResolve }
}

describe('ClarifyingQuestionCard Enter key', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('selects the focused unchecked option without submitting', () => {
    const { onResolve } = renderCard()
    const small = screen.getByRole('radio', { name: 'Small' })

    fireEvent.keyDown(small, { key: 'Enter' })

    expect(small.getAttribute('aria-checked')).toBe('true')
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('moves focus to the next unanswered question when the form is incomplete', () => {
    const { onResolve } = renderCard()
    const small = screen.getByRole('radio', { name: 'Small' })
    fireEvent.click(small)

    fireEvent.keyDown(small, { key: 'Enter' })

    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Kernel' }))
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('submits the answers once every question is answered', () => {
    const { onResolve } = renderCard()
    fireEvent.click(screen.getByRole('radio', { name: 'Small' }))
    const plugin = screen.getByRole('radio', { name: 'Plugin' })
    fireEvent.click(plugin)

    fireEvent.keyDown(plugin, { key: 'Enter' })

    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { [SCOPE]: 'Small', [PLACEMENT]: 'Plugin' } })
    )
  })

  it('does not submit on Shift+Enter', () => {
    const { onResolve } = renderCard()
    fireEvent.click(screen.getByRole('radio', { name: 'Small' }))
    const plugin = screen.getByRole('radio', { name: 'Plugin' })
    fireEvent.click(plugin)

    fireEvent.keyDown(plugin, { key: 'Enter', shiftKey: true })

    expect(onResolve).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import markdown from '../dia-markdown/renderer'
import { Markdown } from './markdown'

const CONTENT = 'Read **the plan**\nthen reply.'

afterEach(cleanup)

describe('Markdown in the chat', () => {
  it('renders formatted Markdown while dia-markdown provides it', async () => {
    await startRendererRegistry({ 'dia-markdown': markdown })
    render(<Markdown content={CONTENT} />)
    expect((await screen.findByText('the plan')).tagName).toBe('STRONG')
  })

  it('shows the plain text with its line breaks while dia-markdown is not loaded', async () => {
    await startRendererRegistry({})
    const { container } = render(<Markdown content={CONTENT} />)
    const paragraph = container.querySelector('p')
    expect([paragraph?.textContent, paragraph?.className]).toEqual([
      CONTENT,
      expect.stringContaining('whitespace-pre-wrap')
    ])
  })

  it('falls back to plain text when dia-markdown unloads', async () => {
    const registry = await startRendererRegistry({ 'dia-markdown': markdown })
    render(<Markdown content={CONTENT} />)
    await act(() => Effect.runPromise(registry.unload('dia-markdown')))
    expect(screen.queryByText('the plan')).toBeNull()
    expect(screen.getByText(/Read \*\*the plan\*\*/)).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from './markdown'

afterEach(cleanup)

describe('Markdown', () => {
  it('highlights a registered language and numbers each line', () => {
    const { container } = render(<Markdown content={'```ts\nconst a = 1\nlet b = 2\n```'} />)

    expect(container.querySelector('pre')?.classList).toContain('tm-code--line-numbers')
    expect(
      [...container.querySelectorAll('.th-line')].map((line) => line.getAttribute('data-line'))
    ).toEqual(['1', '2'])
    expect(
      [...container.querySelectorAll('.th-keyword')].map((token) => token.textContent)
    ).toEqual(['const', 'let'])
  })

  it('resolves a language alias to its registered language', () => {
    const { container } = render(<Markdown content={'```typescript\nconst a = 1\n```'} />)

    expect(container.querySelector('.th-keyword')?.textContent).toBe('const')
  })

  it('marks the lines named in the fence metadata', () => {
    const { container } = render(<Markdown content={'```ts {2}\nconst a = 1\nlet b = 2\n```'} />)

    expect(container.querySelector('.th-line--highlighted')?.getAttribute('data-line')).toBe('2')
  })

  it('shows markup inside a code fence as text instead of rendering it', () => {
    const { container } = render(
      <Markdown content={'```html\n<img src=x onerror=alert(1)>\n```'} />
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('shows the code accumulated so far in a fence that has not closed', () => {
    const { container } = render(<Markdown content={'Here:\n\n```ts\nconst a'} />)

    expect(container.querySelector('code')?.textContent).toBe('const a')
  })

  it('opens links in a new tab', () => {
    render(<Markdown content="See [the docs](https://example.com)." />)

    const link = screen.getByRole('link', { name: 'the docs' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })
})

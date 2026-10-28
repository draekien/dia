// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('Markdown images', () => {
  it('shows a load button naming the host instead of requesting a remote image', () => {
    const { container } = render(<Markdown content="![chart](https://example.com/chart.png)" />)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: 'Load image from example.com' })).toBeTruthy()
  })

  it('renders the remote image once the user clicks the load button', () => {
    const { container } = render(<Markdown content="![chart](https://example.com/chart.png)" />)

    fireEvent.click(screen.getByRole('button', { name: 'Load image from example.com' }))

    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('https://example.com/chart.png')
    expect(image?.getAttribute('alt')).toBe('chart')
  })

  it('cancels the enclosing link when the load button inside it is clicked', () => {
    render(
      <Markdown content="[![chart](https://example.com/chart.png)](https://example.com/page)" />
    )

    const followed = fireEvent.click(
      screen.getByRole('button', { name: 'Load image from example.com' })
    )

    expect(followed).toBe(false)
  })

  it.each([
    ['protocol-relative', '//attacker/share/chart.png'],
    ['relative', '../../chart.png'],
    ['hostless', 'https://']
  ])('shows only the alt text for a %s image source', (_kind, source) => {
    const { container } = render(<Markdown content={`![chart](${source})`} />)

    expect(container.querySelector('img, button')).toBeNull()
    expect(container.textContent).toBe('chart')
  })

  it('applies the same policy to a reference-style image', () => {
    const { container } = render(
      <Markdown content={'![chart][c]\n\n[c]: //attacker/share/chart.png'} />
    )

    expect(container.querySelector('img, button')).toBeNull()
    expect(container.textContent).toBe('chart')
  })
})

describe('Markdown autolinks', () => {
  function links(content: string): Array<[string | null, string | null]> {
    const { container } = render(<Markdown content={content} />)
    return [...container.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent])
  }

  it('links a bare URL', () => {
    expect(links('see https://example.com/docs now')).toEqual([
      ['https://example.com/docs', 'https://example.com/docs']
    ])
  })

  it('opens a bare URL in a new tab', () => {
    render(<Markdown content="see https://example.com" />)

    expect(screen.getByRole('link').getAttribute('target')).toBe('_blank')
  })

  it('links a URL in angle brackets without showing the brackets', () => {
    const { container } = render(<Markdown content="see <https://example.com>" />)

    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(container.textContent).toBe('see https://example.com')
  })

  it('leaves trailing sentence punctuation out of the link', () => {
    const { container } = render(
      <Markdown content="Read https://example.com/a, then https://example.com/b." />
    )

    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/a',
      'https://example.com/b'
    ])
    expect(container.textContent).toBe('Read https://example.com/a, then https://example.com/b.')
  })

  it('leaves a closing parenthesis out unless the URL opened one', () => {
    expect(
      links('(see https://example.com/a) and https://en.wikipedia.org/wiki/Set_(mathematics)')
    ).toEqual([
      ['https://example.com/a', 'https://example.com/a'],
      [
        'https://en.wikipedia.org/wiki/Set_(mathematics)',
        'https://en.wikipedia.org/wiki/Set_(mathematics)'
      ]
    ])
  })

  it('keeps underscores and asterisks in a URL instead of reading them as emphasis', () => {
    expect(links('https://example.com/a_b_c and https://example.com/*x*/y')).toEqual([
      ['https://example.com/a_b_c', 'https://example.com/a_b_c'],
      ['https://example.com/*x*/y', 'https://example.com/*x*/y']
    ])
  })

  it('does not link a URL inside an explicit link label', () => {
    expect(links('[https://a.example](https://b.example)')).toEqual([
      ['https://b.example', 'https://a.example']
    ])
  })

  it('does not link a URL inside inline code or a code fence', () => {
    expect(links('`https://example.com`\n\n```\nhttps://example.com\n```')).toEqual([])
  })

  it('does not link a scheme with no host, or a URL joined to a preceding word', () => {
    expect(links('https:// and xhttps://example.com')).toEqual([])
  })
})

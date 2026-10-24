// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StartupSkeleton } from './startup-skeleton'

afterEach(cleanup)

describe('StartupSkeleton', () => {
  it('says dia is starting in a status region', () => {
    render(<StartupSkeleton />)

    expect(screen.getByRole('status').textContent).toContain('Starting dia')
  })

  it('draws the outline of a conversation with placeholder blocks that carry no text', () => {
    const { container } = render(<StartupSkeleton />)

    const blocks = container.querySelectorAll('[data-slot="skeleton"]')

    expect(blocks).toHaveLength(4)
    for (const block of blocks) expect(block.textContent).toBe('')
  })

  it('stops the placeholder animation when the user prefers reduced motion', () => {
    const { container } = render(<StartupSkeleton />)

    for (const block of container.querySelectorAll('[data-slot="skeleton"]')) {
      expect(block.className).toContain('motion-reduce:animate-none')
    }
  })
})

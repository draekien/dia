// @vitest-environment jsdom

import { TooltipProvider } from '@dia/renderer-plugin'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Atom } from 'effect/reactivity'
import { afterEach, describe, expect, it } from 'vitest'
import { ClickCountEntry } from './click-count-entry'

const show = () =>
  render(
    <TooltipProvider>
      <ClickCountEntry clicks={Atom.make(0)} />
    </TooltipProvider>
  )

afterEach(cleanup)

describe('ClickCountEntry', () => {
  it('shows zero clicks before the first click', () => {
    show()

    expect(screen.getByRole('button', { name: 'Example: 0 clicks' })).toBeTruthy()
  })

  it('shows one click in the singular after one click', () => {
    show()

    fireEvent.click(screen.getByRole('button', { name: 'Example: 0 clicks' }))

    expect(screen.getByRole('button', { name: 'Example: 1 click' })).toBeTruthy()
  })

  it('adds one to the count on each click', () => {
    show()

    fireEvent.click(screen.getByRole('button', { name: 'Example: 0 clicks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Example: 1 click' }))

    expect(screen.getByRole('button', { name: 'Example: 2 clicks' })).toBeTruthy()
  })
})

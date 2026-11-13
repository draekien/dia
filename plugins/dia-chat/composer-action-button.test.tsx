// @vitest-environment jsdom

import { TooltipProvider } from '@dia/renderer-plugin'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composerAction } from './composer-action'
import { ComposerActionButton } from './pane'

afterEach(cleanup)

const hint = ['Queue after this turn with Enter', 'Hold Ctrl to steer now'] as const

const renderButton = (action: ReturnType<typeof composerAction>) => {
  const onStop = vi.fn()
  const onSubmit = vi.fn()
  render(
    <TooltipProvider>
      <ComposerActionButton action={action} hint={hint} onStop={onStop} onSubmit={onSubmit} />
    </TooltipProvider>
  )
  return { onStop, onSubmit }
}

describe('ComposerActionButton', () => {
  it('stops the turn when clicked while running and empty', () => {
    const { onStop, onSubmit } = renderButton(
      composerAction({ running: true, hasText: false, modifierHeld: false, defaultMode: 'queue' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits with the click event, so its Ctrl state reaches the send', () => {
    const { onStop, onSubmit } = renderButton(
      composerAction({ running: true, hasText: true, modifierHeld: false, defaultMode: 'queue' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }), { ctrlKey: true })
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ ctrlKey: true })
    expect(onStop).not.toHaveBeenCalled()
  })

  it('is disabled with nothing to send while idle', () => {
    renderButton(
      composerAction({ running: false, hasText: false, modifierHeld: false, defaultMode: 'queue' })
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true)
  })

  it('announces its label in a polite live region', () => {
    renderButton(
      composerAction({ running: true, hasText: true, modifierHeld: true, defaultMode: 'queue' })
    )
    const live = document.querySelector('[aria-live="polite"]')
    expect(live?.textContent).toBe('Steer now')
  })
})

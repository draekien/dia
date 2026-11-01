// @vitest-environment jsdom

import { TooltipProvider } from '@dia/renderer-plugin'
import type { OutgoingMessage } from '@shared/domain/message-queue'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessages } from './queued-messages'

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

const queue = (count: number): ReadonlyArray<OutgoingMessage> =>
  Array.from({ length: count }, (_, index) => ({
    id: `m-${index + 1}`,
    text: `Message ${index + 1}`
  }))

const handlers = { onSendNow: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn() }

const stackElement = (queued: ReadonlyArray<OutgoingMessage>, held = false) => (
  <TooltipProvider>
    <QueuedMessages queued={queued} held={held} {...handlers} />
  </TooltipProvider>
)

const renderStack = (queued: ReadonlyArray<OutgoingMessage>, held = false) => {
  vi.clearAllMocks()
  const view = render(stackElement(queued, held))
  return { ...handlers, view }
}

const section = () => screen.getByRole('region', { name: 'Queued messages' })
const openStack = () => fireEvent.focus(screen.getByRole('button', { name: /^Show \d+ queued/ }))
const list = () => screen.getByRole('list', { name: /queued .* in send order/ })

describe('QueuedMessages marker', () => {
  it('counts the queue and says it sends when the turn ends', () => {
    renderStack(queue(20))
    expect(section().textContent).toContain('20 queued send in order when this turn ends')
  })

  it('says a held queue sends with the next message', () => {
    renderStack(queue(2), true)
    expect(section().textContent).toContain('2 queued send with your next message')
  })
})

describe('QueuedMessages collapsed stack', () => {
  it('puts the newest message in front as the button that opens the list', () => {
    renderStack(queue(3))
    expect(screen.getByRole('button', { name: 'Show 3 queued messages' }).textContent).toBe(
      'Message 3'
    )
  })

  it('shows at most three older messages behind the front one', () => {
    const { view } = renderStack(queue(20))
    expect(view.container.querySelectorAll('[data-slot=bubble]')).toHaveLength(4)
  })

  it('truncates each bubble to one line', () => {
    renderStack(queue(1))
    expect(screen.getByRole('button', { name: 'Show 1 queued message' }).className).toContain(
      'truncate'
    )
  })

  it('renders nothing for an empty queue', () => {
    const { view } = renderStack([])
    expect(view.container.querySelector('section')).toBeNull()
  })
})

describe('QueuedMessages open list', () => {
  it('opens on focus and lists every message in send order', () => {
    renderStack(queue(20))
    openStack()
    const items = within(list()).getAllByRole('listitem')
    expect(items).toHaveLength(20)
    expect(items[0]?.textContent).toBe('Message 1')
    expect(items[19]?.textContent).toBe('Message 20')
  })

  it.each([
    ['Send now', 'onSendNow'],
    ['Remove', 'onRemove']
  ] as const)('%s calls its handler with the message id', (name, handler) => {
    const handlers = renderStack(queue(3))
    openStack()
    const second = within(list()).getAllByRole('listitem')[1]
    if (second === undefined) throw new Error('missing row')
    fireEvent.click(within(second).getByRole('button', { name }))
    expect(handlers[handler]).toHaveBeenCalledExactlyOnceWith('m-2')
  })

  it('Edit opens the editor and saves the trimmed text for the message id', () => {
    const { onEdit } = renderStack(queue(3))
    openStack()
    const second = within(list()).getAllByRole('listitem')[1]
    if (second === undefined) throw new Error('missing row')
    fireEvent.click(within(second).getByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('textbox', { name: 'Queued message text' })
    fireEvent.change(editor, { target: { value: '  Message two, edited  ' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onEdit).toHaveBeenCalledExactlyOnceWith('m-2', 'Message two, edited')
  })

  it('closes on Escape and returns focus to the front bubble', () => {
    renderStack(queue(3))
    openStack()
    fireEvent.keyDown(list(), { key: 'Escape' })
    expect(screen.queryByRole('list', { name: /in send order/ })).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Show 3 queued messages' })
    )
  })

  it('keeps the list open when Escape cancels an edit', () => {
    renderStack(queue(2))
    openStack()
    const first = within(list()).getAllByRole('listitem')[0]
    if (first === undefined) throw new Error('missing row')
    fireEvent.click(within(first).getByRole('button', { name: 'Edit' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Queued message text' }), {
      key: 'Escape'
    })
    expect(within(list()).getAllByRole('listitem')[0]?.textContent).toBe('Message 1')
  })

  it('opens collapsed for a new queue after the last one emptied while open', () => {
    const { view } = renderStack(queue(1))
    openStack()
    view.rerender(stackElement([]))
    view.rerender(stackElement(queue(1)))
    expect(screen.queryByRole('list', { name: /in send order/ })).toBeNull()
  })

  it('closes once the message being edited leaves the queue and focus leaves', () => {
    const { view } = renderStack(queue(2))
    openStack()
    const first = within(list()).getAllByRole('listitem')[0]
    if (first === undefined) throw new Error('missing row')
    fireEvent.click(within(first).getByRole('button', { name: 'Edit' }))
    view.rerender(stackElement(queue(2).slice(1)))
    fireEvent.blur(screen.getByRole('button', { name: 'Show 1 queued message' }))
    expect(screen.queryByRole('list', { name: /in send order/ })).toBeNull()
  })
})

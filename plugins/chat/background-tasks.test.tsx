// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundTasks } from './background-tasks'

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

const watcher = { taskId: 'b1', description: 'Run the test watcher' }
const reviewer = { taskId: 'a1', description: 'Review the diff' }

describe('BackgroundTasks', () => {
  it('renders nothing while no task runs', () => {
    const { container } = render(<BackgroundTasks tasks={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('counts the running tasks on its trigger', () => {
    render(<BackgroundTasks tasks={[watcher, reviewer]} />)
    expect(
      screen.getByRole('button', { name: '2 tasks running in the background' }).textContent
    ).toBe('2 in background')
  })

  it('names a single task in the singular for screen readers', () => {
    render(<BackgroundTasks tasks={[watcher]} />)
    expect(
      screen.getByRole('button', { name: '1 task running in the background' }).textContent
    ).toBe('1 in background')
  })

  it('lists each task description, in order, once opened', () => {
    render(<BackgroundTasks tasks={[watcher, reviewer]} />)
    expect(screen.queryByText('Run the test watcher')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '2 tasks running in the background' }))

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Run the test watcher',
      'Review the diff'
    ])
  })
})

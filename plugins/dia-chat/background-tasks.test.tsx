// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BackgroundTaskList } from './background-tasks'

afterEach(cleanup)

const watcher = { taskId: 'b1', description: 'Run the test watcher' }
const reviewer = { taskId: 'a1', description: 'Review the diff' }

describe('BackgroundTaskList', () => {
  it('says none are running while the list is empty', () => {
    render(<BackgroundTaskList tasks={[]} />)
    expect(screen.getByText('None running')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists each task description in the order given', () => {
    render(<BackgroundTaskList tasks={[watcher, reviewer]} />)
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Run the test watcher',
      'Review the diff'
    ])
  })
})

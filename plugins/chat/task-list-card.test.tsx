// @vitest-environment jsdom
import type { PaneMessage, ToolCallPart } from '@dia/renderer-plugin'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { latestTodos, TaskList } from './task-list-card'

afterEach(cleanup)

let nextId = 0
const newId = () => `id-${nextId++}`

const todoWrite = (todos: unknown): ToolCallPart => ({
  type: 'tool-call',
  toolCallId: newId(),
  name: 'TodoWrite',
  state: 'done',
  input: { todos }
})

const turn = (...parts: ToolCallPart[]): PaneMessage => ({
  id: newId(),
  role: 'assistant',
  parts
})

const readSchema = { content: 'Read the schema', status: 'completed' } as const
const writeMigration = { content: 'Write the migration', status: 'in_progress' } as const

describe('latestTodos', () => {
  it('is empty when the agent never wrote a task list', () => {
    expect(latestTodos([turn()])).toEqual([])
  })

  it('takes the last TodoWrite call across turns', () => {
    const messages = [turn(todoWrite([readSchema])), turn(todoWrite([readSchema, writeMigration]))]
    expect(latestTodos(messages)).toEqual([readSchema, writeMigration])
  })

  it('drops items without content or with an unknown status', () => {
    const messages = [
      turn(todoWrite([readSchema, { status: 'pending' }, { content: 'Ship', status: 'blocked' }]))
    ]
    expect(latestTodos(messages)).toEqual([readSchema])
  })

  it('is empty when the last TodoWrite call has no todo array', () => {
    expect(latestTodos([turn(todoWrite([readSchema])), turn(todoWrite('oops'))])).toEqual([])
  })
})

describe('TaskList', () => {
  it('says there is no task list while it is empty', () => {
    render(<TaskList todos={[]} />)
    expect(screen.getByText('No task list')).toBeTruthy()
  })

  it('names each item with its status for screen readers', () => {
    render(<TaskList todos={[readSchema, writeMigration]} />)
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Completed: Read the schema',
      'In progress: Write the migration'
    ])
  })
})

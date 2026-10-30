import { describe, expect, it } from 'vitest'
import type { TextPart, ThinkingPart, ToolCallPart } from './pane-chat'
import { hasSteps, sectionDurationMs, sectionSteps, turnBlocks } from './turn-steps'

const text = (content: string, startedAt?: number): TextPart => ({
  type: 'text',
  content,
  ...(startedAt !== undefined ? { startedAt } : {})
})
const thinking = (startedAt?: number): ThinkingPart => ({
  type: 'thinking',
  content: 'weighing it',
  ...(startedAt !== undefined ? { startedAt } : {})
})
const tool = (toolCallId: string, startedAt?: number, endedAt?: number): ToolCallPart => ({
  type: 'tool-call',
  toolCallId,
  name: 'Read',
  state: endedAt === undefined ? 'running' : 'done',
  ...(startedAt !== undefined ? { startedAt } : {}),
  ...(endedAt !== undefined ? { endedAt } : {})
})

describe('turnBlocks: answer-only', () => {
  it('shows a turn with no steps as text only', () => {
    const answer = text('Done.')
    expect(turnBlocks([answer], 'answer-only')).toEqual([answer])
  })

  it('collapses everything up to the last step, text between steps included, and shows the text after it', () => {
    const plan = text('Let me look.')
    const read = tool('t1')
    const edit = tool('t2')
    const answer = text('Fixed it.')
    expect(turnBlocks([plan, read, edit, answer], 'answer-only')).toEqual([
      { type: 'steps', parts: [plan, read, edit] },
      answer
    ])
  })

  it('records when the answer after the last step arrived', () => {
    const [section] = turnBlocks([tool('t1', 1_000), text('Fixed it.', 5_000)], 'answer-only')
    expect(section).toMatchObject({ type: 'steps', followedAt: 5_000 })
  })

  it('collapses a turn that ends on a step into one section with nothing after it', () => {
    const blocks = turnBlocks([text('Looking.'), tool('t1')], 'answer-only')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).not.toHaveProperty('followedAt')
  })
})

describe('turnBlocks: all-text', () => {
  it('shows every text part and collapses each run of consecutive steps separately', () => {
    const plan = text('Let me look.')
    const think = thinking()
    const read = tool('t1')
    const middle = text('Found it.')
    const edit = tool('t2')
    const answer = text('Fixed it.')
    expect(turnBlocks([plan, think, read, middle, edit, answer], 'all-text')).toEqual([
      plan,
      { type: 'steps', parts: [think, read] },
      middle,
      { type: 'steps', parts: [edit] },
      answer
    ])
  })

  it('records when the text after each section arrived', () => {
    const blocks = turnBlocks(
      [tool('t1', 1_000), text('Found it.', 3_000), tool('t2', 4_000)],
      'all-text'
    )
    expect(blocks[0]).toMatchObject({ type: 'steps', followedAt: 3_000 })
    expect(blocks[2]).not.toHaveProperty('followedAt')
  })
})

describe('turnBlocks: blank parts', () => {
  it('keeps one section when only blank text separates two steps in all-text mode', () => {
    const read = tool('t1')
    const edit = tool('t2')
    expect(turnBlocks([read, text('\n\n'), edit], 'all-text')).toEqual([
      { type: 'steps', parts: [read, edit] }
    ])
  })

  it('does not count a blank thinking part as a step', () => {
    const blank: ThinkingPart = { type: 'thinking', content: '' }
    const answer = text('Done.')
    expect(turnBlocks([blank, answer], 'answer-only')).toEqual([answer])
    expect(hasSteps([blank, answer])).toBe(false)
  })
})

describe('sectionSteps', () => {
  it('counts thinking and tool calls but not the text between them', () => {
    const think = thinking()
    const read = tool('t1')
    expect(sectionSteps({ type: 'steps', parts: [text('Looking.'), think, read] })).toEqual([
      think,
      read
    ])
  })
})

describe('sectionDurationMs', () => {
  it('runs from the first arrival to the arrival of the part after the section', () => {
    expect(
      sectionDurationMs({ type: 'steps', parts: [tool('t1', 1_000, 2_000)], followedAt: 9_000 })
    ).toBe(8_000)
  })

  it('ends at the text after the section even when a tool completes later', () => {
    expect(
      sectionDurationMs({ type: 'steps', parts: [tool('t1', 1_000, 60_000)], followedAt: 9_000 })
    ).toBe(8_000)
  })

  it('runs to the latest tool completion when nothing follows the section', () => {
    expect(
      sectionDurationMs({ type: 'steps', parts: [thinking(1_000), tool('t1', 2_000, 7_000)] })
    ).toBe(6_000)
  })

  it('is unknown for a section whose parts carry no times', () => {
    expect(sectionDurationMs({ type: 'steps', parts: [tool('t1')] })).toBeUndefined()
  })
})

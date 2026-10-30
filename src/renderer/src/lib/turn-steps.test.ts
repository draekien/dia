import { describe, expect, it } from 'vitest'
import type { TextPart, ThinkingPart, ToolCallPart } from './pane-chat'
import { hasSteps, sectionDurationMs, turnBlocks } from './turn-steps'

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

describe('turnBlocks', () => {
  it('shows a turn with no steps as text only', () => {
    const answer = text('Done.')
    expect(turnBlocks([answer])).toEqual([answer])
  })

  it('shows every text part and collapses each run of consecutive steps separately', () => {
    const plan = text('Let me look.')
    const think = thinking()
    const read = tool('t1')
    const middle = text('Found it.')
    const edit = tool('t2')
    const answer = text('Fixed it.')
    expect(turnBlocks([plan, think, read, middle, edit, answer])).toEqual([
      plan,
      { type: 'steps', parts: [think, read] },
      middle,
      { type: 'steps', parts: [edit] },
      answer
    ])
  })

  it('records when the text after each section arrived', () => {
    const blocks = turnBlocks([tool('t1', 1_000), text('Found it.', 3_000), tool('t2', 4_000)])
    expect(blocks[0]).toMatchObject({ type: 'steps', followedAt: 3_000 })
    expect(blocks[2]).not.toHaveProperty('followedAt')
  })

  it('keeps one section when only blank text separates two steps', () => {
    const read = tool('t1')
    const edit = tool('t2')
    expect(turnBlocks([read, text('\n\n'), edit])).toEqual([{ type: 'steps', parts: [read, edit] }])
  })

  it('does not count a blank thinking part as a step', () => {
    const blank: ThinkingPart = { type: 'thinking', content: '' }
    const answer = text('Done.')
    expect(turnBlocks([blank, answer])).toEqual([answer])
    expect(hasSteps([blank, answer])).toBe(false)
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

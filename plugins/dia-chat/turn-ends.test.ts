import { describe, expect, it } from 'vitest'
import { turnEnds } from './turn-ends'

const user = (id: string) => ({ id, role: 'user' as const })
const assistant = (id: string) => ({ id, role: 'assistant' as const })
const notice = (id: string) => ({ id, role: 'notice' as const })

describe('turnEnds', () => {
  it('ends each turn at the last message before the next user message', () => {
    const ends = turnEnds([user('u1'), assistant('a1'), user('u2'), assistant('a2')])

    expect([...ends]).toEqual([
      ['a1', ['u1']],
      ['a2', ['u2']]
    ])
  })

  it('opens one turn with every consecutive user message', () => {
    const ends = turnEnds([user('u1'), user('u2'), assistant('a1')])

    expect([...ends]).toEqual([['a1', ['u1', 'u2']]])
  })

  it('ends a turn at its reply, not at a notice before the next message', () => {
    const ends = turnEnds([
      user('u1'),
      assistant('a1'),
      notice('model'),
      user('u2'),
      assistant('a2')
    ])

    expect([...ends]).toEqual([
      ['a1', ['u1']],
      ['a2', ['u2']]
    ])
  })

  it('ends a parked turn at its reply and the resumed turn at the resumed reply', () => {
    const ends = turnEnds([
      user('u1'),
      assistant('a1'),
      notice('parked'),
      user('resumed'),
      assistant('a2')
    ])

    expect([...ends]).toEqual([
      ['a1', ['u1']],
      ['a2', ['resumed']]
    ])
  })

  it('joins a turn that parked before any reply with the turn that resumed it', () => {
    const ends = turnEnds([user('u1'), notice('parked'), user('resumed'), assistant('a2')])

    expect([...ends]).toEqual([['a2', ['u1', 'resumed']]])
  })

  it('ends a turn at an error', () => {
    const ends = turnEnds([user('u1'), { id: 'e1', role: 'error' as const }, user('u2')])

    expect(ends.get('e1')).toEqual(['u1'])
  })

  it('ends a turn with no reply yet at its own user message', () => {
    expect([...turnEnds([user('u1')])]).toEqual([['u1', ['u1']]])
  })

  it('leaves messages before the first user message out of every turn', () => {
    const ends = turnEnds([notice('n0'), user('u1'), assistant('a1')])

    expect([...ends]).toEqual([['a1', ['u1']]])
  })

  it('has no turns for an empty transcript', () => {
    expect(turnEnds([]).size).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { composerAction, composerActionHint, composerPlaceholder } from './composer-action'

describe('composerAction', () => {
  it.each([false, true])('is a disabled Send arrow while idle and empty, modifier %s', (held) => {
    for (const defaultMode of ['queue', 'steer'] as const) {
      expect(
        composerAction({ running: false, hasText: false, modifierHeld: held, defaultMode })
      ).toEqual({
        kind: 'submit',
        icon: 'sendNow',
        label: 'Send',
        mode: defaultMode,
        disabled: true
      })
    }
  })

  it.each([
    ['queue', false, 'queue', 'queue'],
    ['steer', false, 'sendNow', 'steer'],
    ['queue', true, 'sendNow', 'steer'],
    ['steer', true, 'queue', 'queue']
  ] as const)(
    'is Send with the %s default and modifier %s while idle with text',
    (defaultMode, modifierHeld, icon, mode) => {
      expect(composerAction({ running: false, hasText: true, modifierHeld, defaultMode })).toEqual({
        kind: 'submit',
        icon,
        label: 'Send',
        mode,
        disabled: false
      })
    }
  )

  it.each([false, true])('is Stop while running and empty, modifier %s', (held) => {
    for (const defaultMode of ['queue', 'steer'] as const) {
      expect(
        composerAction({ running: true, hasText: false, modifierHeld: held, defaultMode })
      ).toEqual({ kind: 'stop', icon: 'stop', label: 'Stop' })
    }
  })

  it.each([
    ['queue', false, 'queue', 'Queue', 'queue'],
    ['steer', false, 'sendNow', 'Steer now', 'steer'],
    ['queue', true, 'sendNow', 'Steer now', 'steer'],
    ['steer', true, 'queue', 'Queue', 'queue']
  ] as const)(
    'with the %s default and modifier %s while running with text it shows %s as %s',
    (defaultMode, modifierHeld, icon, label, mode) => {
      expect(composerAction({ running: true, hasText: true, modifierHeld, defaultMode })).toEqual({
        kind: 'submit',
        icon,
        label,
        mode,
        disabled: false
      })
    }
  )
})

describe('composerActionHint', () => {
  it('names Enter and the other mode with the given key label while running', () => {
    expect(
      composerActionHint({ running: true, pending: false, defaultMode: 'queue', modifierKey: '⌘' })
    ).toEqual(['Queue after this turn with Enter', 'Hold ⌘ to steer now'])
    expect(
      composerActionHint({
        running: true,
        pending: false,
        defaultMode: 'steer',
        modifierKey: 'Ctrl'
      })
    ).toEqual(['Steer this turn now with Enter', 'Hold Ctrl to queue after this turn'])
  })

  it('says every send steers while a card is pending', () => {
    for (const defaultMode of ['queue', 'steer'] as const) {
      expect(
        composerActionHint({ running: true, pending: true, defaultMode, modifierKey: 'Ctrl' })
      ).toEqual(['Steer this turn now with Enter', 'Every send steers while a card is pending'])
    }
  })

  it('says both modes send at once while idle', () => {
    expect(
      composerActionHint({
        running: false,
        pending: false,
        defaultMode: 'queue',
        modifierKey: 'Ctrl'
      })
    ).toEqual(['Send with Enter', 'Ctrl+Enter also sends now while no turn is running'])
  })
})

describe('composerPlaceholder', () => {
  it.each([
    [false, 'queue', 'Message this agent, or type / for commands'],
    [false, 'steer', 'Message this agent, or type / for commands'],
    [true, 'queue', 'Queue a message for after this turn, or type / for commands'],
    [true, 'steer', 'Steer this turn, or type / for commands']
  ] as const)('running %s with the %s default reads %s', (running, defaultMode, text) => {
    expect(composerPlaceholder(running, defaultMode)).toBe(text)
  })
})

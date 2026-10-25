import { describe, expect, it } from 'vitest'
import { sendModeForEnter } from './send-mode-atom'

const plain = { metaKey: false, ctrlKey: false }
const withCmd = { metaKey: true, ctrlKey: false }
const withCtrl = { metaKey: false, ctrlKey: true }

describe('sendModeForEnter', () => {
  it.each([
    ['queue', plain, 'queue'],
    ['steer', plain, 'steer'],
    ['queue', withCmd, 'steer'],
    ['steer', withCmd, 'queue'],
    ['queue', withCtrl, 'steer'],
    ['steer', withCtrl, 'queue']
  ] as const)('with default %s and keys %o sends in %s', (defaultMode, keys, expected) => {
    expect(sendModeForEnter(defaultMode, keys)).toBe(expected)
  })
})

import { describe, expect, it } from 'vitest'
import { RunsKey } from './runs-seam'

const MEMBERS = [
  'open',
  'start',
  'send',
  'editQueued',
  'removeQueued',
  'sendQueuedNow',
  'answer',
  'interrupt',
  'resumeParked',
  'rewind',
  'setThinkingLevel',
  'setPermissionMode',
  'setModel',
  'awaitIdle',
  'isLive',
  'close',
  'retire',
  'openInTab',
  'discoverSessions'
]

const methods = Object.fromEntries(MEMBERS.map((member) => [member, () => undefined]))

describe('RunsKey', () => {
  it('accepts a run service that has every method and busy', () => {
    expect(RunsKey.is({ ...methods, busy: {} })).toBe(true)
  })

  it('rejects a run service without busy, which the run queue reads', () => {
    expect(RunsKey.is(methods)).toBe(false)
  })
})

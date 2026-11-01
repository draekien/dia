import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { toDiscoveredSessions } from './discovery'

const DIRECTORY = 'F:\\Dev\\app'

const info = (extra: Partial<SDKSessionInfo> = {}): SDKSessionInfo => ({
  sessionId: 's-1',
  summary: 'Summary',
  lastModified: 500,
  cwd: DIRECTORY,
  ...extra
})

describe('toDiscoveredSessions', () => {
  it('titles a session by its custom title', () => {
    const [session] = toDiscoveredSessions([info({ customTitle: 'Renamed' })], DIRECTORY)

    expect(session?.title).toBe('Renamed')
  })

  it('titles a session without a custom title by its summary', () => {
    const [session] = toDiscoveredSessions([info()], DIRECTORY)

    expect(session?.title).toBe('Summary')
  })

  it('starts a session at its creation time', () => {
    const [session] = toDiscoveredSessions([info({ createdAt: 100 })], DIRECTORY)

    expect(session?.startedAt).toBe(100)
  })

  it('starts a session without a creation time at its last change', () => {
    const [session] = toDiscoveredSessions([info()], DIRECTORY)

    expect(session?.startedAt).toBe(500)
  })

  it("resumes every session on Claude Code's default model", () => {
    const [session] = toDiscoveredSessions([info()], DIRECTORY)

    expect(session?.model).toBe('default')
  })

  it('leaves out a session whose working directory is another directory', () => {
    const sessions = toDiscoveredSessions(
      [info({ sessionId: 's-other', cwd: 'F:\\Dev\\app-b' }), info({ sessionId: 's-here' })],
      DIRECTORY
    )

    expect(sessions.map((session) => session.sessionId)).toEqual(['s-here'])
  })

  it('keeps a session that records no working directory', () => {
    const sessions = toDiscoveredSessions([info({ cwd: undefined })], DIRECTORY)

    expect(sessions.map((session) => session.sessionId)).toEqual(['s-1'])
  })
})

import { Either, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { PaneConfig, PaneRecord, type WorktreeInfo } from './pane'

describe('PaneConfig', () => {
  it('round-trips through encode/decode', () => {
    const value: PaneConfig = {
      paneId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      cwd: '/home/william/projects/dia',
      model: 'claude-sonnet-5',
      thinkingLevel: 'high',
      permissionMode: 'acceptEdits'
    }

    const encoded = Schema.encodeSync(PaneConfig)(value)
    const decoded = Schema.decodeUnknownSync(PaneConfig)(encoded)

    expect(decoded).toEqual(value)
  })

  it('preserves each permission mode through encode/decode', () => {
    for (const permissionMode of ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk'] as const) {
      const value: PaneConfig = {
        paneId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        cwd: '/home/william/projects/dia',
        model: 'claude-sonnet-5',
        thinkingLevel: 'adaptive',
        permissionMode
      }

      const decoded = Schema.decodeUnknownSync(PaneConfig)(Schema.encodeSync(PaneConfig)(value))

      expect(decoded.permissionMode).toBe(permissionMode)
    }
  })

  it('defaults thinkingLevel to adaptive when absent (migrating older records)', () => {
    const decoded = Schema.decodeUnknownSync(PaneConfig)({
      paneId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      cwd: '/home/william/projects/dia',
      model: 'claude-sonnet-5'
    })

    expect(decoded.thinkingLevel).toBe('adaptive')
  })

  it('defaults permissionMode to default when absent (migrating older records)', () => {
    const decoded = Schema.decodeUnknownSync(PaneConfig)({
      paneId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      cwd: '/home/william/projects/dia',
      model: 'claude-sonnet-5'
    })

    expect(decoded.permissionMode).toBe('default')
  })

  it('round-trips with an optional worktree field set', () => {
    const worktree: WorktreeInfo = {
      path: '/home/william/.dia/worktrees/3fa85f64-5717-4562-b3fc-2c963f66afa6',
      branch: 'dia/3fa85f64-5717-4562-b3fc-2c963f66afa6',
      sourceRepo: '/home/william/projects/dia'
    }
    const value: PaneConfig = {
      paneId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      cwd: worktree.path,
      model: 'claude-sonnet-5',
      thinkingLevel: 'adaptive',
      permissionMode: 'default',
      worktree
    }

    const encoded = Schema.encodeSync(PaneConfig)(value)
    const decoded = Schema.decodeUnknownSync(PaneConfig)(encoded)

    expect(decoded).toEqual(value)
  })

  it('rejects a malformed value', () => {
    const result = Schema.decodeUnknownEither(PaneConfig)({
      paneId: 'not-a-uuid',
      cwd: '/home/william',
      model: 'claude-sonnet-5'
    })

    expect(Either.isLeft(result)).toBe(true)
  })
})

describe('PaneRecord', () => {
  it('round-trips through encode/decode, including history', () => {
    const value: PaneRecord = {
      config: {
        paneId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        cwd: '/home/william/projects/dia',
        model: 'claude-sonnet-5',
        thinkingLevel: 'adaptive',
        permissionMode: 'default'
      },
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' }
      ],
      attention: { _tag: 'Idle' }
    }

    const encoded = Schema.encodeSync(PaneRecord)(value)
    const decoded = Schema.decodeUnknownSync(PaneRecord)(encoded)

    expect(decoded).toEqual(value)
  })

  it('rejects a malformed value', () => {
    const result = Schema.decodeUnknownEither(PaneRecord)({
      config: { paneId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', cwd: '/x', model: 'm' },
      history: [{ role: 'not-a-role', content: 'oops' }]
    })

    expect(Either.isLeft(result)).toBe(true)
  })
})

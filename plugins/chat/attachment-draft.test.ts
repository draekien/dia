import { ContentAttachment, PathAttachment, type ProjectEntry } from '@shared/domain/attachment'
import { describe, expect, it } from 'vitest'
import {
  activeMentionToken,
  attachmentLabel,
  entryPath,
  filterProjectEntries,
  formatMegabytes,
  planFile,
  removeToken
} from './attachment-draft'

const MiB = 1024 * 1024
const png = { mediaType: 'image/png', block: 'image' as const, maxBytes: 3.75 * MiB }
const file = (overrides: Partial<Parameters<typeof planFile>[0]>) => ({
  name: 'shot.png',
  type: 'image/png',
  size: 1000,
  path: 'F:\\shots\\shot.png',
  isDirectory: false,
  ...overrides
})

describe('planFile', () => {
  it('reads an accepted type that fits as a content block', () => {
    expect(planFile(file({}), [png])).toEqual({ _tag: 'read', mediaType: 'image/png' })
  })

  it('reads an accepted type exactly at the limit', () => {
    expect(planFile(file({ size: png.maxBytes }), [png])._tag).toBe('read')
  })

  it('rejects an accepted type one byte over the limit, naming the limit', () => {
    expect(planFile(file({ size: png.maxBytes + 1 }), [png])).toEqual({
      _tag: 'reject',
      reason: 'Too large, 3.75 MB max'
    })
  })

  it('attaches a type the adapter does not accept as its path', () => {
    expect(planFile(file({ type: 'application/pdf', path: 'F:\\a.pdf' }), [png])).toEqual({
      _tag: 'attach',
      attachment: PathAttachment.make({ path: 'F:\\a.pdf', kind: 'file' })
    })
  })

  it('attaches a directory as a directory path', () => {
    expect(planFile(file({ type: '', path: 'F:\\repo\\docs', isDirectory: true }), [png])).toEqual({
      _tag: 'attach',
      attachment: PathAttachment.make({ path: 'F:\\repo\\docs', kind: 'directory' })
    })
  })

  it('rejects a file with no accepted type and no path', () => {
    expect(planFile(file({ type: 'text/plain', path: '' }), [png])._tag).toBe('reject')
  })

  it('attaches every file as a path when the adapter accepts no types', () => {
    expect(planFile(file({}), [])._tag).toBe('attach')
  })
})

describe('formatMegabytes', () => {
  it('drops trailing zeros', () => {
    expect(formatMegabytes(5 * MiB)).toBe('5 MB')
  })
})

describe('attachmentLabel', () => {
  const cwd = 'F:\\Dev\\dia'

  it('shows a path inside cwd relative to it with / separators', () => {
    expect(
      attachmentLabel(
        PathAttachment.make({ path: 'F:\\Dev\\dia\\src\\main.ts', kind: 'file' }),
        cwd
      )
    ).toBe('src/main.ts')
  })

  it('ends a directory with /', () => {
    expect(
      attachmentLabel(
        PathAttachment.make({ path: 'F:\\Dev\\dia\\docs\\adr', kind: 'directory' }),
        cwd
      )
    ).toBe('docs/adr/')
  })

  it('shows a path outside cwd in full, including a sibling that shares the prefix', () => {
    expect(
      attachmentLabel(PathAttachment.make({ path: 'F:\\Dev\\dia-two\\a.ts', kind: 'file' }), cwd)
    ).toBe('F:\\Dev\\dia-two\\a.ts')
  })

  it('shows an image by its file name', () => {
    expect(
      attachmentLabel(
        ContentAttachment.make({ name: 'shot.png', mediaType: 'image/png', data: '' }),
        cwd
      )
    ).toBe('shot.png')
  })
})

describe('entryPath', () => {
  it('joins with the separator cwd uses', () => {
    expect(entryPath('F:\\Dev\\dia', { path: 'docs/adr', kind: 'directory' })).toBe(
      'F:\\Dev\\dia\\docs\\adr'
    )
    expect(entryPath('/home/me/dia/', { path: 'src/a.ts', kind: 'file' })).toBe(
      '/home/me/dia/src/a.ts'
    )
  })
})

describe('activeMentionToken', () => {
  it('finds the path typed after @', () => {
    expect(activeMentionToken('see @src/ma', 11)).toEqual({ query: 'src/ma', start: 4, end: 11 })
  })

  it('ignores an @ inside a word', () => {
    expect(activeMentionToken('me@example.com', 14)).toBeNull()
  })
})

describe('filterProjectEntries', () => {
  const entries: ReadonlyArray<ProjectEntry> = [
    { path: 'plugins', kind: 'directory' },
    { path: 'plugins/chat/pane.tsx', kind: 'file' },
    { path: 'src/main/pane-window.ts', kind: 'file' },
    { path: 'docs/plan.md', kind: 'file' },
    { path: 'src/expand.ts', kind: 'file' }
  ]

  it('ranks a name prefix, then a substring, then characters in order', () => {
    expect(filterProjectEntries(entries, 'pan').map((entry) => entry.path)).toEqual([
      'plugins/chat/pane.tsx',
      'src/main/pane-window.ts',
      'src/expand.ts',
      'docs/plan.md'
    ])
  })

  it('matches without regard to case', () => {
    expect(filterProjectEntries(entries, 'PLUG').map((entry) => entry.path)).toEqual([
      'plugins',
      'plugins/chat/pane.tsx'
    ])
  })

  it('returns every entry up to the limit for an empty query', () => {
    expect(filterProjectEntries(entries, '', 2)).toHaveLength(2)
  })

  it('returns nothing when no entry matches', () => {
    expect(filterProjectEntries(entries, 'zzz')).toEqual([])
  })
})

describe('removeToken', () => {
  it('removes the token and one space after it', () => {
    expect(removeToken('fix @pan now', { query: 'pan', start: 4, end: 8 })).toEqual({
      value: 'fix now',
      caret: 4
    })
  })
})

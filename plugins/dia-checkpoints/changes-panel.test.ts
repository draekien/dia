import { describe, expect, it } from 'vitest'
import { patchLines, turnSummary } from './changes-panel'

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 5626abf..f719efd 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1 +1,2 @@',
  ' one',
  '-two',
  '+three',
  ''
].join('\n')

describe('patchLines', () => {
  it('drops the file headers and marks hunk, context, deleted and added lines', () => {
    expect(patchLines(PATCH)).toEqual([
      { text: '@@ -1 +1,2 @@', kind: 'hunk' },
      { text: ' one', kind: 'context' },
      { text: '-two', kind: 'deleted' },
      { text: '+three', kind: 'added' }
    ])
  })

  it('has no lines for a patch without a hunk, as for a binary file', () => {
    expect(
      patchLines('diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n')
    ).toEqual([])
  })
})

const change = (path: string, added: number, deleted: number, binary = false) => ({
  path,
  added,
  deleted,
  binary
})

describe('turnSummary', () => {
  it('counts the files and totals their added and deleted lines', () => {
    expect(turnSummary([change('a.ts', 10, 1), change('b.ts', 4, 2)])).toBe('2 files +14 −3')
  })

  it('names a single file in the singular', () => {
    expect(turnSummary([change('a.ts', 1, 0)])).toBe('1 file +1 −0')
  })

  it('counts a binary file without adding lines', () => {
    expect(turnSummary([change('a.ts', 3, 0), change('logo.png', 0, 0, true)])).toBe(
      '2 files +3 −0'
    )
  })
})

import { describe, expect, it } from 'vitest'
import { patchLines } from './changes-card'

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

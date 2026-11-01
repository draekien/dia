import { describe, expect, it } from 'vitest'
import { scanPatchLog } from './push-scan'

const SECRET = ['ghp', 'Zq8Xw2Lm4Np6Rt0Vb3Hk7Jd9Sf1Gc5TyAbCd'].join('_')
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

const commit = (sha: string, message: string, patch: string) => `\0${sha}\n${message}\n\0\n${patch}`

const filePatch = (path: string, hunks: string) =>
  [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    hunks
  ].join('\n')

describe('scanPatchLog', () => {
  it('reports a secret on an added line with its file, new line number and commit', () => {
    const output = commit(
      COMMIT_A,
      'docs: add a note',
      filePatch('instructions.md', `@@ -3,0 +4,2 @@ heading\n+first\n+use ${SECRET}\n`)
    )

    expect(scanPatchLog(output).findings).toEqual([
      {
        rule: 'github-token',
        description: 'GitHub token',
        commit: COMMIT_A,
        file: 'instructions.md',
        line: 5
      }
    ])
  })

  it('numbers lines from each hunk header in a file with several hunks', () => {
    const output = commit(
      COMMIT_A,
      'docs: edit',
      filePatch('notes.md', `@@ -1 +1 @@\n-old\n+new\n@@ -10,0 +11 @@\n+${SECRET}\n`)
    )

    expect(scanPatchLog(output).findings.map((finding) => finding.line)).toEqual([11])
  })

  it('reports a secret in a commit message with no file', () => {
    const output = commit(COMMIT_B, `chore: rotate\n\nold key ${SECRET}`, '')

    expect(scanPatchLog(output).findings).toEqual([
      expect.objectContaining({ commit: COMMIT_B, file: null, line: 3 })
    ])
  })

  it('ignores a removed line and a deleted file', () => {
    const deleted = [
      'diff --git a/old.md b/old.md',
      'deleted file mode 100644',
      '--- a/old.md',
      '+++ /dev/null',
      `@@ -1 +0,0 @@\n-${SECRET}`
    ].join('\n')
    const output = commit(
      COMMIT_A,
      'chore: remove the key',
      `${filePatch('keep.md', `@@ -1 +0,0 @@\n-${SECRET}`)}\n${deleted}\n`
    )

    expect(scanPatchLog(output).findings).toEqual([])
  })

  it('treats an added line whose text starts with "++ " as content, not a file header', () => {
    const output = commit(
      COMMIT_A,
      'docs: diff sample',
      filePatch('sample.md', `@@ -0,0 +1 @@\n+++ ${SECRET}\n`)
    )

    expect(scanPatchLog(output).findings).toEqual([
      expect.objectContaining({ file: 'sample.md', line: 1 })
    ])
  })

  it('reads a line that ends in a carriage return', () => {
    const output = commit(
      COMMIT_A,
      'docs: windows line endings',
      filePatch('win.md', `@@ -0,0 +1 @@\r\n+-----BEGIN RSA PRIVATE KEY-----\r\n`)
    )

    expect(scanPatchLog(output).findings.map((finding) => finding.rule)).toEqual(['private-key'])
  })

  it('counts every commit, including one with no patch', () => {
    const output = `${commit(COMMIT_A, 'chore: empty', '')}${commit(COMMIT_B, 'docs: x', filePatch('x.md', '@@ -0,0 +1 @@\n+x\n'))}`

    expect(scanPatchLog(output)).toEqual({ commitCount: 2, findings: [] })
  })

  it('reads empty output as no commits', () => {
    expect(scanPatchLog('')).toEqual({ commitCount: 0, findings: [] })
  })
})

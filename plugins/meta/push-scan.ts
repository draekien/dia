import { type SecretFinding, SecretFinding as SecretFindingSchema } from '@dia/plugin'
import { findSecretRule } from './secret-rules'

/**
 * The `git log` options whose output {@link scanPatchLog} reads: each commit's SHA and message
 * between NUL bytes, then its patch against its first parent with no context lines. Every file
 * is diffed as text and the user's diff settings cannot change the format or run a program. Run
 * `git -c core.quotePath=false log ...SCAN_LOG_OPTIONS <head> --not --remotes=<remote>` to list
 * exactly the commits a push of `<head>` sends.
 */
export const SCAN_LOG_OPTIONS: ReadonlyArray<string> = [
  '-p',
  '--text',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--unified=0',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--diff-merges=first-parent',
  '--format=%x00%H%n%B%x00'
]

/** What {@link scanPatchLog} found: how many commits it read and every secret in them. */
export interface PushScan {
  readonly commitCount: number
  readonly findings: ReadonlyArray<SecretFinding>
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const NEW_FILE_HEADER = '+++ '

const stripCarriageReturn = (line: string): string =>
  line.endsWith('\r') ? line.slice(0, -1) : line

const finding = (commit: string, file: string | null, line: number, text: string) => {
  const rule = findSecretRule(text)
  return rule === undefined
    ? []
    : [
        SecretFindingSchema.make({
          rule: rule.id,
          description: rule.description,
          commit,
          file,
          line
        })
      ]
}

const scanMessage = (commit: string, message: string): ReadonlyArray<SecretFinding> =>
  message
    .split('\n')
    .flatMap((text, index) => finding(commit, null, index + 1, stripCarriageReturn(text)))

const scanPatch = (commit: string, patch: string): ReadonlyArray<SecretFinding> => {
  const findings: Array<SecretFinding> = []
  let file: string | null = null
  let inHunk = false
  let nextLine = 0
  for (const raw of patch.split('\n')) {
    const text = stripCarriageReturn(raw)
    if (text.startsWith('diff --git ')) {
      inHunk = false
      file = null
      continue
    }
    const hunk = HUNK_HEADER.exec(text)
    if (hunk !== null) {
      inHunk = true
      nextLine = Number(hunk[1])
      continue
    }
    if (!inHunk) {
      if (text.startsWith(NEW_FILE_HEADER)) {
        const path = text.slice(NEW_FILE_HEADER.length)
        file = path.startsWith('b/') ? path.slice(2) : null
      }
      continue
    }
    if (text.startsWith('+')) {
      if (file !== null) findings.push(...finding(commit, file, nextLine, text.slice(1)))
      nextLine += 1
    }
  }
  return findings
}

/**
 * Scans the output of `git log` run with {@link SCAN_LOG_OPTIONS}: every added line, under its
 * file and line number in the commit that adds it, and every commit message line. Removed lines
 * and lines of deleted files are not scanned.
 */
export const scanPatchLog = (output: string): PushScan => {
  const parts = output.split('\0')
  const findings: Array<SecretFinding> = []
  let commitCount = 0
  for (let index = 1; index < parts.length; index += 2) {
    const header = parts[index] ?? ''
    const newline = header.indexOf('\n')
    const commit = newline === -1 ? header : header.slice(0, newline)
    if (commit === '') continue
    commitCount += 1
    findings.push(...scanMessage(commit, newline === -1 ? '' : header.slice(newline + 1)))
    findings.push(...scanPatch(commit, parts[index + 1] ?? ''))
  }
  return { commitCount, findings }
}

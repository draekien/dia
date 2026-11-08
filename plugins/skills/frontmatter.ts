import { Option } from 'effect'

/** The `SKILL.md` frontmatter fields the skills plugin reads. */
export interface Frontmatter {
  readonly name: Option.Option<string>
  readonly description: Option.Option<string>
}

const KEY = /^([A-Za-z_][\w-]*):(?:\s(.*))?$/
const BLOCK = /^([>|])([+-]?)\d?([+-]?)$/

const isDelimiter = (line: string | undefined): boolean => line?.trimEnd() === '---'

const isContinuation = (line: string): boolean => line.trim() === '' || /^\s/.test(line)

const continuationOf = (lines: ReadonlyArray<string>, start: number): ReadonlyArray<string> => {
  const taken: Array<string> = []
  for (let index = start; index < lines.length && isContinuation(lines[index] ?? ''); index++) {
    taken.push(lines[index] ?? '')
  }
  while (taken.length > 0 && taken[taken.length - 1]?.trim() === '') taken.pop()
  return taken
}

const indentOf = (lines: ReadonlyArray<string>): number => {
  const first = lines.find((line) => line.trim() !== '') ?? ''
  return first.length - first.trimStart().length
}

const foldLines = (lines: ReadonlyArray<string>): string =>
  lines.reduce((folded, line, index) => {
    if (index === 0) return line
    if (line === '') return `${folded}\n`
    return folded.endsWith('\n') || folded === '' ? `${folded}${line}` : `${folded} ${line}`
  }, '')

const blockScalar = (style: string, chomp: string, body: ReadonlyArray<string>): string => {
  const indent = indentOf(body)
  const lines = body.map((line) => (line.trim() === '' ? '' : line.slice(indent)))
  const text = style === '|' ? lines.join('\n') : foldLines(lines)
  if (chomp === '-') return text
  return `${text}\n`
}

const quoted = (raw: string, rest: ReadonlyArray<string>): Option.Option<string> => {
  const quote = raw[0]
  const joined = [raw, ...rest.map((line) => line.trim())].join(' ')
  if (quote === "'") {
    const match = /^'((?:[^']|'')*)'/.exec(joined)
    return match === null ? Option.none() : Option.some((match[1] ?? '').replaceAll("''", "'"))
  }
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(joined)
  if (match === null) return Option.none()
  try {
    return Option.some(JSON.parse(`"${match[1] ?? ''}"`) as string)
  } catch {
    return Option.none()
  }
}

const scalar = (raw: string, rest: ReadonlyArray<string>): Option.Option<string> => {
  const block = BLOCK.exec(raw)
  if (block !== null) {
    return Option.some(blockScalar(block[1] ?? '>', block[2] || block[3] || '', rest))
  }
  if (raw.startsWith('"') || raw.startsWith("'")) return quoted(raw, rest)
  const plain = [raw.replace(/\s+#.*$/, ''), ...rest.map((line) => line.trim())]
    .filter((part) => part !== '')
    .join(' ')
  return plain === '' ? Option.none() : Option.some(plain)
}

/**
 * Reads `name` and `description` from the frontmatter of a `SKILL.md` file's `text`: the block
 * between a first line `---` and the next `---`. Each field is read when it is a plain, single- or
 * double-quoted, or block (`>`, `>-`, `|`, `|-`) scalar; any other form leaves it `None`. Returns
 * `None` when `text` has no frontmatter block. Accepts LF or CRLF line endings and a leading byte
 * order mark.
 */
export const readFrontmatter = (text: string): Option.Option<Frontmatter> => {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (!isDelimiter(lines[0])) return Option.none()
  const end = lines.findIndex((line, index) => index > 0 && isDelimiter(line))
  if (end === -1) return Option.none()
  const block = lines.slice(1, end)
  const fields = new Map<string, Option.Option<string>>()
  block.forEach((line, index) => {
    const match = KEY.exec(line)
    if (match === null) return
    const key = match[1] ?? ''
    if (key !== 'name' && key !== 'description') return
    fields.set(key, scalar((match[2] ?? '').trim(), continuationOf(block, index + 1)))
  })
  return Option.some({
    name: fields.get('name') ?? Option.none(),
    description: fields.get('description') ?? Option.none()
  })
}

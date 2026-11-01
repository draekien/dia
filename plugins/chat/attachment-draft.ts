import {
  type Attachment,
  type AttachmentType,
  PathAttachment,
  type ProjectEntry
} from '@shared/domain/attachment'
import { activeTriggerToken, type TriggerToken } from './slash-command-filter'

/**
 * One chip in the composer: `Ready` holds an attachment the message will send; `Rejected` names a
 * file that cannot be sent and why. `key` is unique within the composer.
 */
export type DraftAttachment =
  | { readonly _tag: 'Ready'; readonly key: string; readonly attachment: Attachment }
  | {
      readonly _tag: 'Rejected'
      readonly key: string
      readonly name: string
      readonly reason: string
    }

/** What the composer knows about a dropped, pasted or picked file before reading it. */
export interface IncomingFile {
  readonly name: string
  readonly type: string
  readonly size: number
  readonly path: string
  readonly isDirectory: boolean
}

/**
 * How to attach `file`: `read` its bytes as a `mediaType` content block when the adapter accepts
 * the type and it fits; `attach` it as a path otherwise; `reject` it, with the chip's reason, when
 * an accepted type is too large or a file has neither an accepted type nor a path.
 */
export type FilePlan =
  | { readonly _tag: 'read'; readonly mediaType: string }
  | { readonly _tag: 'attach'; readonly attachment: PathAttachment }
  | { readonly _tag: 'reject'; readonly reason: string }

/** `bytes` in megabytes with up to two decimals, e.g. `3.75 MB`. */
export const formatMegabytes = (bytes: number): string =>
  `${Number((bytes / (1024 * 1024)).toFixed(2))} MB`

/** Decides how to attach `file`, given the content-block `types` the adapter accepts. */
export const planFile = (file: IncomingFile, types: ReadonlyArray<AttachmentType>): FilePlan => {
  const accepted = file.isDirectory ? undefined : types.find((type) => type.mediaType === file.type)
  if (accepted !== undefined) {
    return file.size > accepted.maxBytes
      ? { _tag: 'reject', reason: `Too large, ${formatMegabytes(accepted.maxBytes)} max` }
      : { _tag: 'read', mediaType: accepted.mediaType }
  }
  if (file.path === '') return { _tag: 'reject', reason: 'This file has no path to send' }
  return {
    _tag: 'attach',
    attachment: PathAttachment.make({
      path: file.path,
      kind: file.isDirectory ? 'directory' : 'file'
    })
  }
}

const separatorOf = (directory: string): string => (directory.includes('\\') ? '\\' : '/')

const comparable = (path: string): string => path.replaceAll('\\', '/').toLowerCase()

/** The last segment of `path`, for either separator. */
export const baseName = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) ?? path

/**
 * The chip label of `attachment` in a session working in `cwd`: an image's file name; a path
 * relative to `cwd` with `/` separators, or the absolute path when it is outside `cwd`. A directory
 * ends in `/`.
 */
export const attachmentLabel = (attachment: Attachment, cwd: string): string => {
  if (attachment._tag === 'ContentAttachment') return attachment.name
  const root = `${comparable(cwd).replace(/\/+$/, '')}/`
  const inside = comparable(attachment.path).startsWith(root)
  const shown = inside ? attachment.path.slice(root.length).replaceAll('\\', '/') : attachment.path
  return attachment.kind === 'directory' ? `${shown.replace(/[\\/]+$/, '')}/` : shown
}

/** The absolute path of `entry` under `cwd`, written with the separator `cwd` uses. */
export const entryPath = (cwd: string, entry: ProjectEntry): string => {
  const separator = separatorOf(cwd)
  return `${cwd.replace(/[\\/]+$/, '')}${separator}${entry.path.split('/').join(separator)}`
}

/**
 * The `@` path token at the caret, as {@link activeTriggerToken} finds it for any run of
 * characters other than whitespace and `@`: `see @src/ma` yields query `'src/ma'`, and `a@b`
 * yields `null`.
 */
export const activeMentionToken = (input: string, caret: number): TriggerToken | null =>
  activeTriggerToken(input, caret, { char: '@', isNameChar: (char) => /[^\s@]/.test(char) })

const isSubsequence = (needle: string, haystack: string): boolean => {
  let index = 0
  for (const char of haystack) if (char === needle[index]) index++
  return index === needle.length
}

/**
 * The entries `query` matches, case-insensitively, best first: those whose last segment begins
 * with it, then those whose path contains it, then those whose path holds its characters in
 * order. Each group keeps the input order. An empty `query` matches every entry. Returns at most
 * `limit` entries.
 */
export const filterProjectEntries = (
  entries: ReadonlyArray<ProjectEntry>,
  query: string,
  limit = 50
): ReadonlyArray<ProjectEntry> => {
  const needle = query.toLowerCase()
  const groups: [Array<ProjectEntry>, Array<ProjectEntry>, Array<ProjectEntry>] = [[], [], []]
  for (const entry of entries) {
    const path = entry.path.toLowerCase()
    if (baseName(path).startsWith(needle)) groups[0].push(entry)
    else if (path.includes(needle)) groups[1].push(entry)
    else if (isSubsequence(needle, path)) groups[2].push(entry)
  }
  return groups.flat().slice(0, limit)
}

/**
 * The input after removing the `@` `token` a path was chosen for, with one space after it dropped,
 * and the caret where the token began.
 */
export const removeToken = (
  input: string,
  token: TriggerToken
): { readonly value: string; readonly caret: number } => ({
  value: input.slice(0, token.start) + input.slice(token.end).replace(/^ /, ''),
  caret: token.start
})

/** The attachments of `drafts` the message will send, in chip order. */
export const readyAttachments = (
  drafts: ReadonlyArray<DraftAttachment>
): ReadonlyArray<Attachment> =>
  drafts.flatMap((draft) => (draft._tag === 'Ready' ? [draft.attachment] : []))

import {
  type Attachment,
  type AttachmentType,
  ContentAttachment,
  type ProjectEntry
} from '@shared/domain/attachment'
import { useQuery } from '@tanstack/react-query'
import { Duration } from 'effect'
import { Base64 } from 'effect/encoding'
import { useRef, useState } from 'react'
import { type DraftAttachment, planFile, readyAttachments } from './attachment-draft'

/** A file from a drop, paste or file input, and whether it is a directory. */
export interface DroppedFile {
  readonly file: File
  readonly isDirectory: boolean
}

/**
 * The files in `data`, a drop's or paste's `DataTransfer`, each marked a directory when the
 * platform reports it as one. Returns an empty list when `data` carries no files.
 */
export const filesOf = (data: DataTransfer): ReadonlyArray<DroppedFile> =>
  [...data.items].flatMap((item) => {
    const file = item.kind === 'file' ? item.getAsFile() : null
    return file === null
      ? []
      : [{ file, isDirectory: item.webkitGetAsEntry()?.isDirectory === true }]
  })

const PASTED_NAME = 'Pasted image'

const pathOf = (draft: DraftAttachment): string | undefined =>
  draft._tag === 'Ready' && draft.attachment._tag === 'PathAttachment'
    ? draft.attachment.path
    : undefined

/**
 * The composer's attachment chips. `add` plans each file against the adapter's `types` (see
 * `planFile`), reads accepted ones as content blocks, and appends a chip per file; `attach`
 * appends a path chip. A path already attached is not added again. `remove(key)` and
 * `removeLast()` drop chips; `clear()` empties the row after a send. `ready` is what a send
 * carries; `reading` is true while an `add` is still reading files, and a send must wait for it.
 */
export function useComposerAttachments(types: ReadonlyArray<AttachmentType>) {
  const [drafts, setDrafts] = useState<ReadonlyArray<DraftAttachment>>([])
  const [reads, setReads] = useState(0)
  const nextKey = useRef(0)
  const keyFor = (): string => `attachment-${nextKey.current++}`

  const append = (incoming: ReadonlyArray<DraftAttachment>): void =>
    setDrafts((current) => {
      const paths = new Set(current.map(pathOf))
      return [
        ...current,
        ...incoming.filter((draft) => {
          const path = pathOf(draft)
          if (path === undefined) return true
          if (paths.has(path)) return false
          paths.add(path)
          return true
        })
      ]
    })

  const toDraft = ({ file, isDirectory }: DroppedFile): Promise<DraftAttachment> => {
    const name = file.name === '' ? PASTED_NAME : file.name
    const plan = planFile(
      { name, type: file.type, size: file.size, path: window.dia.pathForFile(file), isDirectory },
      types
    )
    const key = keyFor()
    if (plan._tag === 'attach') {
      return Promise.resolve({ _tag: 'Ready', key, attachment: plan.attachment })
    }
    if (plan._tag === 'reject') {
      return Promise.resolve({ _tag: 'Rejected', key, name, reason: plan.reason })
    }
    return file.arrayBuffer().then(
      (bytes): DraftAttachment => ({
        _tag: 'Ready',
        key,
        attachment: ContentAttachment.make({
          name,
          mediaType: plan.mediaType,
          data: Base64.encode(new Uint8Array(bytes))
        })
      }),
      (): DraftAttachment => ({ _tag: 'Rejected', key, name, reason: 'Could not read this file' })
    )
  }

  return {
    drafts,
    ready: readyAttachments(drafts),
    reading: reads > 0,
    add: (files: ReadonlyArray<DroppedFile>): Promise<void> => {
      setReads((count) => count + 1)
      return Promise.all(files.map(toDraft))
        .then(append)
        .finally(() => setReads((count) => count - 1))
    },
    attach: (attachment: Attachment): void =>
      append([{ _tag: 'Ready', key: keyFor(), attachment }]),
    remove: (key: string): void =>
      setDrafts((current) => current.filter((draft) => draft.key !== key)),
    removeLast: (): void => setDrafts((current) => current.slice(0, -1)),
    clear: (): void => setDrafts([])
  }
}

const PROJECT_ENTRIES_STALE = Duration.toMillis(Duration.seconds(10))

/**
 * The `@` menu's entries for a session working in `cwd`, read through
 * `window.dia.listProjectEntries` when `active` turns true and the last read for `cwd` is more than
 * 10 seconds old. While `active` is false the list is empty. `loading` is true until the first
 * read for `cwd` finishes. A failed read gives an empty list.
 */
export function useProjectEntries(
  cwd: string,
  active: boolean
): { readonly entries: ReadonlyArray<ProjectEntry>; readonly loading: boolean } {
  const { data, isPending } = useQuery({
    queryKey: ['projectEntries', cwd],
    queryFn: () =>
      window.dia.listProjectEntries(cwd).then(
        (entries) => entries,
        (): ReadonlyArray<ProjectEntry> => []
      ),
    enabled: active,
    staleTime: PROJECT_ENTRIES_STALE
  })
  return { entries: active ? (data ?? []) : [], loading: active && isPending }
}

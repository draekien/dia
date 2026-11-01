import {
  type Attachment,
  type AttachmentType,
  ContentAttachment,
  type ProjectEntry
} from '@shared/domain/attachment'
import { useEffect, useRef, useState } from 'react'
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

const CHUNK = 0x8000

const toBase64 = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let start = 0; start < view.length; start += CHUNK) {
    binary += String.fromCharCode(...view.subarray(start, start + CHUNK))
  }
  return btoa(binary)
}

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
 * carries.
 */
export function useComposerAttachments(types: ReadonlyArray<AttachmentType>) {
  const [drafts, setDrafts] = useState<ReadonlyArray<DraftAttachment>>([])
  const nextKey = useRef(0)
  const keyFor = (): string => `attachment-${nextKey.current++}`

  const append = (incoming: ReadonlyArray<DraftAttachment>): void =>
    setDrafts((current) => {
      const paths = new Set(current.map(pathOf))
      return [
        ...current,
        ...incoming.filter((draft) => {
          const path = pathOf(draft)
          return path === undefined || !paths.has(path)
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
          data: toBase64(bytes)
        })
      }),
      (): DraftAttachment => ({ _tag: 'Rejected', key, name, reason: 'Could not read this file' })
    )
  }

  return {
    drafts,
    ready: readyAttachments(drafts),
    add: (files: ReadonlyArray<DroppedFile>): Promise<void> =>
      Promise.all(files.map(toDraft)).then(append),
    attach: (attachment: Attachment): void =>
      append([{ _tag: 'Ready', key: keyFor(), attachment }]),
    remove: (key: string): void =>
      setDrafts((current) => current.filter((draft) => draft.key !== key)),
    removeLast: (): void => setDrafts((current) => current.slice(0, -1)),
    clear: (): void => setDrafts([])
  }
}

/**
 * The `@` menu's entries for a session working in `cwd`, read through
 * `window.dia.listProjectEntries` each time `active` turns true. While `active` is false the list
 * is empty. `loading` is true until the first read for `cwd` finishes; a later read keeps showing
 * the previous list until it finishes. A failed read gives an empty list.
 */
export function useProjectEntries(
  cwd: string,
  active: boolean
): { readonly entries: ReadonlyArray<ProjectEntry>; readonly loading: boolean } {
  const [loaded, setLoaded] = useState<{
    readonly cwd: string
    readonly entries: ReadonlyArray<ProjectEntry>
  } | null>(null)

  useEffect(() => {
    if (!active) return
    let current = true
    window.dia.listProjectEntries(cwd).then(
      (entries) => {
        if (current) setLoaded({ cwd, entries })
      },
      () => {
        if (current) setLoaded({ cwd, entries: [] })
      }
    )
    return () => {
      current = false
    }
  }, [active, cwd])

  const fresh = loaded?.cwd === cwd ? loaded.entries : undefined
  return { entries: active ? (fresh ?? []) : [], loading: active && fresh === undefined }
}

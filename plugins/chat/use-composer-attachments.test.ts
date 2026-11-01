// @vitest-environment jsdom

import { ContentAttachment, PathAttachment } from '@shared/domain/attachment'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerAttachments } from './use-composer-attachments'

const MiB = 1024 * 1024
const types = [{ mediaType: 'image/png', block: 'image' as const, maxBytes: 3.75 * MiB }]
const paths = new Map<File, string>()

beforeEach(() => {
  vi.stubGlobal('dia', { pathForFile: (file: File) => paths.get(file) ?? '' })
})
afterEach(() => {
  paths.clear()
  vi.unstubAllGlobals()
})

const fileAt = (path: string, name: string, type: string, bytes: BlobPart = 'abc') => {
  const file = new File([bytes], name, { type })
  paths.set(file, path)
  return file
}

const setup = () => renderHook(() => useComposerAttachments(types))

describe('useComposerAttachments', () => {
  it('reads an accepted image as a base64 content attachment', async () => {
    const { result } = setup()
    await act(() => result.current.add([{ file: fileAt('', '', 'image/png'), isDirectory: false }]))
    expect(result.current.ready).toEqual([
      ContentAttachment.make({ name: 'Pasted image', mediaType: 'image/png', data: btoa('abc') })
    ])
  })

  it('reports reading until the dropped files are read', async () => {
    const { result } = setup()
    let added: Promise<void> = Promise.resolve()
    act(() => {
      added = result.current.add([{ file: fileAt('', '', 'image/png'), isDirectory: false }])
    })
    expect(result.current.reading).toBe(true)
    await act(() => added)
    expect(result.current.reading).toBe(false)
  })

  it('keeps an image over the limit as a rejected chip that is not sent', async () => {
    const { result } = setup()
    const big = new Uint8Array(3.75 * MiB + 1)
    await act(() =>
      result.current.add([
        { file: fileAt('F:/a.png', 'a.png', 'image/png', big), isDirectory: false }
      ])
    )
    expect(result.current.drafts).toMatchObject([
      { _tag: 'Rejected', name: 'a.png', reason: 'Too large, 3.75 MB max' }
    ])
    expect(result.current.ready).toEqual([])
  })

  it('attaches any other file, and a directory, as its path', async () => {
    const { result } = setup()
    await act(() =>
      result.current.add([
        { file: fileAt('F:/repo/a.pdf', 'a.pdf', 'application/pdf'), isDirectory: false },
        { file: fileAt('F:/repo/docs', 'docs', ''), isDirectory: true }
      ])
    )
    expect(result.current.ready).toEqual([
      PathAttachment.make({ path: 'F:/repo/a.pdf', kind: 'file' }),
      PathAttachment.make({ path: 'F:/repo/docs', kind: 'directory' })
    ])
  })

  it('does not attach a path twice', async () => {
    const { result } = setup()
    const docs = PathAttachment.make({ path: 'F:/repo/docs', kind: 'directory' })
    act(() => result.current.attach(docs))
    act(() => result.current.attach(docs))
    expect(result.current.ready).toEqual([docs])
  })

  it('removes the last chip, then a chip by key, then clears', () => {
    const { result } = setup()
    const a = PathAttachment.make({ path: 'F:/a', kind: 'file' })
    const b = PathAttachment.make({ path: 'F:/b', kind: 'file' })
    const c = PathAttachment.make({ path: 'F:/c', kind: 'file' })
    act(() => {
      result.current.attach(a)
      result.current.attach(b)
      result.current.attach(c)
    })
    act(() => result.current.removeLast())
    expect(result.current.ready).toEqual([a, b])
    act(() => result.current.remove(result.current.drafts[0]?.key ?? ''))
    expect(result.current.ready).toEqual([b])
    act(() => result.current.clear())
    expect(result.current.drafts).toEqual([])
  })
})

import { describe, expect, it } from '@effect/vitest'
import { ContentAttachment, PathAttachment } from '@shared/domain/attachment'
import { outsideDirectories, toUserContent } from './attachments'

const image = ContentAttachment.make({ name: 'a.png', mediaType: 'image/png', data: 'AAA' })
const imageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAA' }
}

describe('toUserContent', () => {
  it('sends a message without attachments as its text', () => {
    expect(toUserContent({ id: '1', text: 'hello' })).toBe('hello')
  })

  it('sends a message of only images as image blocks with no text block', () => {
    expect(toUserContent({ id: '1', text: '', attachments: [image] })).toEqual([imageBlock])
  })

  it('leaves out a content attachment whose type is not an image', () => {
    const pdf = ContentAttachment.make({ name: 'a.pdf', mediaType: 'application/pdf', data: 'B' })
    expect(toUserContent({ id: '1', text: 'read', attachments: [pdf] })).toBe('read')
  })

  it('lists every path on its own line after a blank line', () => {
    const attachments = [
      PathAttachment.make({ path: 'F:/repo/docs', kind: 'directory' }),
      PathAttachment.make({ path: 'F:/repo/a.ts', kind: 'file' })
    ]
    expect(toUserContent({ id: '1', text: 'why?', attachments })).toBe(
      'why?\n\nF:/repo/docs\nF:/repo/a.ts'
    )
  })
})

describe('outsideDirectories', () => {
  const cwd = 'F:/repo'

  it('ignores paths inside the working directory', () => {
    expect(
      outsideDirectories([PathAttachment.make({ path: 'F:/repo/src/a.ts', kind: 'file' })], cwd)
    ).toEqual([])
  })

  it("adds a file's parent directory and a directory itself, once each", () => {
    expect(
      outsideDirectories(
        [
          PathAttachment.make({ path: 'F:/other/a.ts', kind: 'file' }),
          PathAttachment.make({ path: 'F:/other/b.ts', kind: 'file' }),
          PathAttachment.make({ path: 'F:/shared', kind: 'directory' }),
          image
        ],
        cwd
      ).map((directory) => directory.replaceAll('\\', '/'))
    ).toEqual(['F:/other', 'F:/shared'])
  })

  it('treats a sibling directory whose name starts with the cwd name as outside', () => {
    expect(
      outsideDirectories([PathAttachment.make({ path: 'F:/repo-two', kind: 'directory' })], cwd)
    ).toEqual(['F:/repo-two'])
  })
})

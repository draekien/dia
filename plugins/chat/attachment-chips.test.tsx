// @vitest-environment jsdom

import { ContentAttachment, PathAttachment } from '@shared/domain/attachment'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentChip } from './attachment-chips'
import { MessageView } from './pane'

afterEach(cleanup)

const cwd = 'F:/repo'
const image = ContentAttachment.make({ name: 'shot.png', mediaType: 'image/png', data: 'AAA' })

describe('AttachmentChip', () => {
  it('names its remove button after the chip and calls onRemove', () => {
    const onRemove = vi.fn()
    render(
      <AttachmentChip
        draft={{
          _tag: 'Ready',
          key: 'k',
          attachment: PathAttachment.make({ path: 'F:/repo/docs/adr', kind: 'directory' })
        }}
        cwd={cwd}
        onRemove={onRemove}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove docs/adr/' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('shows why a rejected file is not attached', () => {
    render(
      <AttachmentChip
        draft={{ _tag: 'Rejected', key: 'k', name: 'huge.png', reason: 'Too large, 3.75 MB max' }}
        cwd={cwd}
      />
    )
    expect(screen.getByText('Too large, 3.75 MB max')).toBeTruthy()
  })

  it('marks a path that was missing at send time', () => {
    const { container } = render(
      <AttachmentChip
        draft={{
          _tag: 'Ready',
          key: 'k',
          attachment: PathAttachment.make({ path: 'F:/repo/gone.ts', kind: 'file', missing: true })
        }}
        cwd={cwd}
      />
    )
    expect(screen.getByText('missing')).toBeTruthy()
    expect(container.querySelector('[data-slot=attachment]')?.getAttribute('data-state')).toBe(
      'error'
    )
  })

  it('offers an image preview', () => {
    render(<AttachmentChip draft={{ _tag: 'Ready', key: 'k', attachment: image }} cwd={cwd} />)
    expect(screen.getByRole('button', { name: 'Preview shot.png' })).toBeTruthy()
  })
})

describe('MessageView attachments', () => {
  it('shows a user turn’s attachments read-only under its text', () => {
    render(
      <MessageView
        message={{
          id: 'u1',
          role: 'user',
          parts: [{ type: 'text', content: 'why?' }],
          attachments: [image, PathAttachment.make({ path: 'F:/other/a.ts', kind: 'file' })]
        }}
        cwd={cwd}
      />
    )
    const list = screen.getByRole('list', { name: 'Attachments' })
    expect(list.textContent).toBe('shot.pngF:/other/a.ts')
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull()
  })
})

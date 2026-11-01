// @effect-diagnostics-next-line nodeBuiltinImport:off -- pure path arithmetic on the session's cwd, with no I/O.
import { dirname, isAbsolute, relative } from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Attachment, AttachmentType, PathAttachment } from '@shared/domain/attachment'
import type { OutgoingMessage } from '@shared/domain/message-queue'

const IMAGE_MAX_BYTES = 3.75 * 1024 * 1024
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

const isImageMediaType = (mediaType: string): mediaType is ImageMediaType =>
  IMAGE_MEDIA_TYPES.some((type) => type === mediaType)

/**
 * The file types a Claude Code session accepts as content blocks: PNG, JPEG, GIF and WebP images
 * up to 3.75 MiB, which is the API's 5 MB limit once base64-encoded. Any other file is sent as its
 * path for the agent's Read tool.
 */
export const CLAUDE_CODE_ATTACHMENT_TYPES: ReadonlyArray<AttachmentType> = IMAGE_MEDIA_TYPES.map(
  (mediaType) => ({ mediaType, block: 'image', maxBytes: IMAGE_MAX_BYTES })
)

type UserContent = SDKUserMessage['message']['content']

const pathsOf = (attachments: ReadonlyArray<Attachment>): ReadonlyArray<PathAttachment> =>
  attachments.filter((attachment) => attachment._tag === 'PathAttachment')

/**
 * The content of the user message that sends `message`: its text, followed by a blank line and
 * one absolute path per line for each path attachment, then one image block per image
 * attachment; a content attachment of any other type is left out. A message with no attachments is sent as its text alone; a message with only images
 * is sent as image blocks alone.
 */
export const toUserContent = (message: OutgoingMessage): UserContent => {
  const attachments = message.attachments ?? []
  const paths = pathsOf(attachments).map((attachment) => attachment.path)
  const text = [message.text, paths.join('\n')].filter((part) => part !== '').join('\n\n')
  const images = attachments.flatMap((attachment) =>
    attachment._tag === 'ContentAttachment' && isImageMediaType(attachment.mediaType)
      ? [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: attachment.mediaType,
              data: attachment.data
            }
          }
        ]
      : []
  )
  if (images.length === 0) return text
  return [...(text === '' ? [] : [{ type: 'text' as const, text }]), ...images]
}

/**
 * The directories the agent needs added to its working directories to read `attachments` from a
 * session in `cwd`: for each path attachment outside `cwd`, the directory itself or the file's
 * parent directory, without duplicates.
 */
export const outsideDirectories = (
  attachments: ReadonlyArray<Attachment>,
  cwd: string
): ReadonlyArray<string> => {
  const outside = pathsOf(attachments).filter((attachment) => {
    const fromCwd = relative(cwd, attachment.path)
    return fromCwd.startsWith('..') || isAbsolute(fromCwd)
  })
  return [
    ...new Set(
      outside.map((attachment) =>
        attachment.kind === 'directory' ? attachment.path : dirname(attachment.path)
      )
    )
  ]
}

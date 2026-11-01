import { Schema } from 'effect'

/**
 * A file sent to the agent as a content block: `name` is the file name shown on its chip,
 * `mediaType` one of the adapter's {@link AttachmentType}s, and `data` the file bytes in base64.
 */
export const ContentAttachment = Schema.TaggedStruct('ContentAttachment', {
  name: Schema.String,
  mediaType: Schema.String,
  data: Schema.String
})
export type ContentAttachment = typeof ContentAttachment.Type

/** Whether a {@link PathAttachment} names a file or a directory. */
export const PathKind = Schema.Literals(['file', 'directory'])
export type PathKind = typeof PathKind.Type

/**
 * A file or directory sent to the agent as its absolute `path`, for the agent to read with its
 * own tools. `missing` is true when the path did not exist when the message was sent; the path is
 * sent anyway.
 */
export const PathAttachment = Schema.TaggedStruct('PathAttachment', {
  path: Schema.String,
  kind: PathKind,
  missing: Schema.optional(Schema.Boolean)
})
export type PathAttachment = typeof PathAttachment.Type

/** Material attached to a user message; match on `_tag`. */
export const Attachment = Schema.Union([ContentAttachment, PathAttachment])
export type Attachment = typeof Attachment.Type

/**
 * A file type the agent adapter accepts as a content block: files of `mediaType` up to
 * `maxBytes` are sent as a `block` content block; any other file is sent as its path.
 */
export const AttachmentType = Schema.Struct({
  mediaType: Schema.String,
  block: Schema.Literal('image'),
  maxBytes: Schema.Int
})
export type AttachmentType = typeof AttachmentType.Type

/**
 * A file or directory under a session's working directory, offered by the `@` path menu. `path`
 * is relative to that directory and `/`-separated.
 */
export const ProjectEntry = Schema.Struct({ path: Schema.String, kind: PathKind })
export type ProjectEntry = typeof ProjectEntry.Type

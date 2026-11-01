import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger
} from '@dia/renderer-plugin'
import type { Attachment as SentAttachment } from '@shared/domain/attachment'
import { cva } from 'class-variance-authority'
import { FileIcon, FolderIcon, XIcon } from 'lucide-react'
import { attachmentLabel, baseName, type DraftAttachment } from './attachment-draft'

const dataUrl = (attachment: Extract<SentAttachment, { _tag: 'ContentAttachment' }>): string =>
  `data:${attachment.mediaType};base64,${attachment.data}`

const MISSING = 'missing'

function PathIcon({ kind }: { kind: 'file' | 'directory' }): React.JSX.Element {
  return kind === 'directory' ? <FolderIcon /> : <FileIcon />
}

function ImagePreview({ label, src }: { label: string; src: string }): React.JSX.Element {
  return (
    <Dialog>
      <DialogTrigger render={<AttachmentTrigger aria-label={`Preview ${label}`} />} />
      <DialogContent className="w-auto max-w-[min(90vw,64rem)]">
        <DialogTitle className="truncate pr-6 font-normal text-sm">{label}</DialogTitle>
        <img src={src} alt={label} className="max-h-[75vh] w-auto rounded-md object-contain" />
      </DialogContent>
    </Dialog>
  )
}

/**
 * One attachment chip: an image thumbnail that opens a preview, or a file or folder icon with
 * its path as `attachmentLabel` shows it for `cwd`. A rejected draft shows its reason, and a path
 * that was missing when sent shows `missing`, both in the error colour. Pass `onRemove` to show a
 * remove button named `Remove <label>`; without it the chip is read-only.
 */
export function AttachmentChip({
  draft,
  cwd,
  onRemove
}: {
  draft: DraftAttachment
  cwd: string
  onRemove?: () => void
}): React.JSX.Element {
  const attachment = draft._tag === 'Ready' ? draft.attachment : undefined
  const label = draft._tag === 'Ready' ? attachmentLabel(draft.attachment, cwd) : draft.name
  const reason =
    draft._tag === 'Rejected'
      ? draft.reason
      : attachment?._tag === 'PathAttachment' && attachment.missing === true
        ? MISSING
        : undefined
  return (
    <Attachment
      size="xs"
      state={reason === undefined ? 'done' : 'error'}
      className="min-w-0 max-w-64"
    >
      <AttachmentMedia variant={attachment?._tag === 'ContentAttachment' ? 'image' : 'icon'}>
        {attachment?._tag === 'ContentAttachment' ? (
          <img src={dataUrl(attachment)} alt="" />
        ) : (
          <PathIcon kind={attachment?._tag === 'PathAttachment' ? attachment.kind : 'file'} />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={attachment?._tag === 'PathAttachment' ? attachment.path : label}>
          {label}
        </AttachmentTitle>
        {reason !== undefined && <AttachmentDescription>{reason}</AttachmentDescription>}
      </AttachmentContent>
      {attachment?._tag === 'ContentAttachment' && (
        <ImagePreview label={label} src={dataUrl(attachment)} />
      )}
      {onRemove !== undefined && (
        <AttachmentActions>
          <AttachmentAction aria-label={`Remove ${label}`} onClick={onRemove}>
            <XIcon />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  )
}

/**
 * The chips of a sent user message, read-only, right-aligned under its text. Renders nothing for
 * no attachments.
 */
export function SentAttachments({
  attachments,
  cwd
}: {
  attachments: ReadonlyArray<SentAttachment>
  cwd: string
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <ul aria-label="Attachments" className="flex flex-wrap justify-end gap-1.5">
      {attachments.map((attachment, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: attachments carry no id, and two can share a name; the chips hold no state
          key={index}
        >
          <AttachmentChip draft={{ _tag: 'Ready', key: String(index), attachment }} cwd={cwd} />
        </li>
      ))}
    </ul>
  )
}

const compactChip = cva(
  'inline-flex h-5 min-w-0 max-w-32 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-[11px] leading-none [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      missing: {
        false: 'border-border text-muted-foreground',
        true: 'border-destructive/40 text-destructive'
      }
    }
  }
)

/** How many attachments a queued bubble's row shows before it counts the rest as `+N`. */
export const QUEUED_ATTACHMENT_LIMIT = 4

/**
 * One line of a queued message's attachments: 28×20 image thumbnails and 20px path chips, the
 * first {@link QUEUED_ATTACHMENT_LIMIT} of them, then `+N` for the rest. Renders nothing for no
 * attachments.
 */
export function QueuedAttachmentRow({
  attachments,
  className
}: {
  attachments: ReadonlyArray<SentAttachment>
  className?: string
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  const shown = attachments.slice(0, QUEUED_ATTACHMENT_LIMIT)
  const hidden = attachments.length - shown.length
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      {shown.map((attachment, index) =>
        attachment._tag === 'ContentAttachment' ? (
          <img
            // biome-ignore lint/suspicious/noArrayIndexKey: attachments carry no id, and two can share a name; the chips hold no state
            key={index}
            src={dataUrl(attachment)}
            alt={attachment.name}
            className="h-5 w-7 shrink-0 rounded-sm object-cover"
          />
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: attachments carry no id, and two can share a name; the chips hold no state
            key={index}
            className={compactChip({ missing: attachment.missing === true })}
            title={attachment.path}
          >
            <PathIcon kind={attachment.kind} />
            <span className="truncate">{baseName(attachment.path)}</span>
          </span>
        )
      )}
      {hidden > 0 && (
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">+{hidden}</span>
      )}
    </span>
  )
}

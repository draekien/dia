import {
  Bubble,
  BubbleContent,
  Button,
  cn,
  Marker,
  MarkerContent,
  MarkerIcon,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@dia/renderer-plugin'
import type { Attachment } from '@shared/domain/attachment'
import type { OutgoingMessage } from '@shared/domain/message-queue'
import { cva } from 'class-variance-authority'
import { ArrowUpIcon, ListPlusIcon, PencilIcon, XIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { AttachmentChip, QueuedAttachmentRow } from './attachment-chips'

interface QueuedMessagesProps {
  readonly queued: ReadonlyArray<OutgoingMessage>
  readonly held: boolean
  readonly cwd: string
  readonly onSendNow: (messageId: string) => void
  readonly onEdit: (messageId: string, text: string, attachments: ReadonlyArray<Attachment>) => void
  readonly onRemove: (messageId: string) => void
}

const BUBBLE_HEIGHT = 32
const ATTACHED_BUBBLE_HEIGHT = 54
const LAYER_OFFSETS = [0, 22, 34, 40] as const

const dashedBubble =
  '*:data-[slot=bubble-content]:border-dashed *:data-[slot=bubble-content]:py-1.5'

const bubbleHeight = cva('', {
  variants: {
    attached: {
      false: '*:data-[slot=bubble-content]:h-8',
      true: '*:data-[slot=bubble-content]:h-[54px] *:data-[slot=bubble-content]:py-1'
    }
  },
  defaultVariants: { attached: false }
})

const hasAttachments = (message: OutgoingMessage): boolean => (message.attachments?.length ?? 0) > 0

function BubbleBody({ message }: { message: OutgoingMessage }): React.ReactNode {
  if (!hasAttachments(message)) return message.text
  return (
    <span className="flex min-w-0 flex-col items-end gap-0.5">
      {message.text !== '' && <span className="max-w-full truncate">{message.text}</span>}
      <QueuedAttachmentRow attachments={message.attachments ?? []} />
    </span>
  )
}

const stackLayer = cva(cn('absolute right-0', dashedBubble), {
  variants: {
    depth: {
      0: 'z-[4] *:data-[slot=bubble-content]:border-muted-foreground/60',
      1: 'z-[3] *:data-[slot=bubble-content]:border-muted-foreground/40 *:data-[slot=bubble-content]:pt-0.5 *:data-[slot=bubble-content]:text-foreground/70',
      2: 'z-[2] *:data-[slot=bubble-content]:border-muted-foreground/35 *:data-[slot=bubble-content]:text-transparent',
      3: 'z-[1] *:data-[slot=bubble-content]:border-muted-foreground/35 *:data-[slot=bubble-content]:text-transparent'
    }
  }
})

const scrollToEnd = (list: HTMLOListElement | null): void => {
  if (list !== null) list.scrollTop = list.scrollHeight
}

function QueueMarker({ count, held }: { count: number; held: boolean }): React.JSX.Element {
  return (
    <Marker variant="separator" className="py-1 text-xs after:hidden">
      <MarkerIcon>
        <ListPlusIcon className="size-3.5" />
      </MarkerIcon>
      <MarkerContent>
        <span className="font-medium text-foreground">{count} queued</span>{' '}
        {held ? 'send with your next message' : 'send in order when this turn ends'}
      </MarkerContent>
    </Marker>
  )
}

function RowAction({
  label,
  tooltip,
  onClick,
  children
}: {
  label: string
  tooltip: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function QueuedRow({
  message,
  held,
  onSendNow,
  onEdit,
  onRemove
}: {
  message: OutgoingMessage
  held: boolean
  onSendNow: () => void
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <li className="group/row flex items-center justify-end gap-1.5">
      <div className="flex gap-0.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
        <RowAction
          label="Send now"
          tooltip={held ? 'Send now' : 'Send now and steer this turn'}
          onClick={onSendNow}
        >
          <ArrowUpIcon />
        </RowAction>
        <RowAction label="Edit" tooltip="Edit" onClick={onEdit}>
          <PencilIcon />
        </RowAction>
        <RowAction label="Remove" tooltip="Remove" onClick={onRemove}>
          <XIcon />
        </RowAction>
      </div>
      <Bubble
        variant="outline"
        align="end"
        className={cn(
          'min-w-0',
          dashedBubble,
          bubbleHeight({ attached: hasAttachments(message) }),
          '*:data-[slot=bubble-content]:border-muted-foreground/60'
        )}
      >
        <BubbleContent className="truncate">
          <BubbleBody message={message} />
        </BubbleContent>
      </Bubble>
    </li>
  )
}

/**
 * A pane's queued messages above its composer, as a stack: the newest message in front and up to
 * three older ones behind it. Pointer or focus on the stack opens it upward over the transcript
 * into a list in send order, where each message can be sent now (`onSendNow`), edited (`onEdit`,
 * which receives the trimmed new text, never blank) or removed (`onRemove`), each by message id.
 * Escape closes the list. `held` changes the marker from "send in order when this turn ends" to
 * "send with your next message". Renders nothing when `queued` is empty.
 */
export function QueuedMessages({
  queued,
  held,
  cwd,
  onSendNow,
  onEdit,
  onRemove
}: QueuedMessagesProps): React.JSX.Element | null {
  if (queued.length === 0) return null
  return (
    <QueueStack
      queued={queued}
      held={held}
      cwd={cwd}
      onSendNow={onSendNow}
      onEdit={onEdit}
      onRemove={onRemove}
    />
  )
}

function QueueStack({
  queued,
  held,
  cwd,
  onSendNow,
  onEdit,
  onRemove
}: QueuedMessagesProps): React.JSX.Element {
  const sectionRef = useRef<HTMLElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const editing = queued.some((message) => message.id === editingId)
  const open = (hovered || focused || editing) && !dismissed
  const focusFront = (): void => {
    sectionRef.current?.querySelector<HTMLElement>('[data-queue-front]')?.focus()
  }
  const layers = queued.slice(-LAYER_OFFSETS.length).reverse()
  const [front, ...behind] = layers
  const frontHeight =
    front !== undefined && hasAttachments(front) ? ATTACHED_BUBBLE_HEIGHT : BUBBLE_HEIGHT
  const lift = frontHeight - BUBBLE_HEIGHT
  const height = frontHeight + LAYER_OFFSETS[layers.length - 1]
  const noun = queued.length === 1 ? 'message' : 'messages'

  return (
    <section
      ref={sectionRef}
      aria-label="Queued messages"
      className="relative mb-1.5"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false)
        if (!focused) setDismissed(false)
      }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        setFocused(false)
        if (!hovered) setDismissed(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !open) return
        event.preventDefault()
        setDismissed(true)
        focusFront()
      }}
    >
      <div aria-hidden={open || undefined}>
        <QueueMarker count={queued.length} held={held} />
      </div>
      <div className="relative" style={{ height }}>
        {behind.map((message, index) => (
          <Bubble
            key={message.id}
            variant="outline"
            align="end"
            aria-hidden
            className={cn(stackLayer({ depth: (index + 1) as 1 | 2 | 3 }), bubbleHeight())}
            style={{ bottom: LAYER_OFFSETS[index + 1] + lift }}
          >
            <BubbleContent className="truncate">{message.text}</BubbleContent>
          </Bubble>
        ))}
        {front !== undefined && (
          <Bubble
            variant="outline"
            align="end"
            className={cn(
              stackLayer({ depth: 0 }),
              bubbleHeight({ attached: hasAttachments(front) })
            )}
            style={{ bottom: 0 }}
          >
            <BubbleContent asChild>
              <button
                type="button"
                data-queue-front
                aria-expanded={open}
                aria-label={`Show ${queued.length} queued ${noun}`}
                className="truncate"
                onClick={() => setDismissed(false)}
              >
                <BubbleBody message={front} />
              </button>
            </BubbleContent>
          </Bubble>
        )}
      </div>
      {open && (
        <div className="absolute inset-x-0 bottom-0 z-10 bg-background motion-safe:animate-in motion-safe:fade-in-0">
          <QueueMarker count={queued.length} held={held} />
          <ol
            aria-label={`${queued.length} queued ${noun}, in send order`}
            ref={scrollToEnd}
            className="flex max-h-[250px] flex-col gap-1.5 overflow-y-auto pt-6 [mask-image:linear-gradient(transparent,#000_24px)] [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]"
          >
            {queued.map((message) =>
              message.id === editingId ? (
                <li key={message.id}>
                  <QueuedMessageEditor
                    initialText={message.text}
                    initialAttachments={message.attachments ?? []}
                    cwd={cwd}
                    onSave={(text, attachments) => {
                      onEdit(message.id, text, attachments)
                      setEditingId(null)
                      focusFront()
                    }}
                    onCancel={() => {
                      setEditingId(null)
                      focusFront()
                    }}
                  />
                </li>
              ) : (
                <QueuedRow
                  key={message.id}
                  message={message}
                  held={held}
                  onSendNow={() => {
                    onSendNow(message.id)
                    focusFront()
                  }}
                  onEdit={() => setEditingId(message.id)}
                  onRemove={() => {
                    onRemove(message.id)
                    focusFront()
                  }}
                />
              )
            )}
          </ol>
        </div>
      )}
    </section>
  )
}

function QueuedMessageEditor({
  initialText,
  initialAttachments,
  cwd,
  onSave,
  onCancel
}: {
  readonly initialText: string
  readonly initialAttachments: ReadonlyArray<Attachment>
  readonly cwd: string
  readonly onSave: (text: string, attachments: ReadonlyArray<Attachment>) => void
  readonly onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState(initialText)
  const [kept, setKept] = useState(initialAttachments)
  const trimmed = text.trim()
  const canSave = trimmed !== '' || kept.length > 0
  const save = (): void => {
    if (canSave) onSave(trimmed, kept)
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-1.5">
      <Textarea
        autoFocus
        aria-label="Queued message text"
        className="min-h-14"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            save()
          }
        }}
      />
      {kept.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {kept.map((attachment, index) => (
            <AttachmentChip
              // biome-ignore lint/suspicious/noArrayIndexKey: attachments carry no id, and two can share a name; the chips hold no state
              key={index}
              draft={{ _tag: 'Ready', key: String(index), attachment }}
              cwd={cwd}
              onRemove={() => setKept((current) => current.filter((_, at) => at !== index))}
            />
          ))}
        </div>
      )}
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="xs" disabled={!canSave} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}

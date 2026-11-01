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
import type { OutgoingMessage } from '@shared/domain/message-queue'
import { cva } from 'class-variance-authority'
import { ArrowUpIcon, ListPlusIcon, PencilIcon, XIcon } from 'lucide-react'
import { useState } from 'react'

interface QueuedMessagesProps {
  readonly queued: ReadonlyArray<OutgoingMessage>
  readonly held: boolean
  readonly onSendNow: (messageId: string) => void
  readonly onEdit: (messageId: string, text: string) => void
  readonly onRemove: (messageId: string) => void
}

const BUBBLE_HEIGHT = 32
const LAYER_OFFSETS = [0, 22, 34, 40] as const

const dashedBubble =
  '*:data-[slot=bubble-content]:h-8 *:data-[slot=bubble-content]:border-dashed *:data-[slot=bubble-content]:py-1.5'

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
  onSendNow,
  onEdit,
  onRemove
}: {
  message: OutgoingMessage
  onSendNow: () => void
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <li className="group/row flex items-center justify-end gap-1.5">
      <div className="flex gap-0.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
        <RowAction label="Send now" tooltip="Send now and steer this turn" onClick={onSendNow}>
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
          '*:data-[slot=bubble-content]:border-muted-foreground/60'
        )}
      >
        <BubbleContent className="truncate">{message.text}</BubbleContent>
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
  onSendNow,
  onEdit,
  onRemove
}: QueuedMessagesProps): React.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  if (queued.length === 0) return null

  const open = (hovered || focused || editingId !== null) && !dismissed
  const layers = queued.slice(-LAYER_OFFSETS.length).reverse()
  const [front, ...behind] = layers
  const height = BUBBLE_HEIGHT + LAYER_OFFSETS[layers.length - 1]
  const noun = queued.length === 1 ? 'message' : 'messages'

  return (
    <section
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
        event.currentTarget.querySelector<HTMLElement>('[data-queue-front]')?.focus()
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
            className={stackLayer({ depth: (index + 1) as 1 | 2 | 3 })}
            style={{ bottom: LAYER_OFFSETS[index + 1] }}
          >
            <BubbleContent className="truncate">{message.text}</BubbleContent>
          </Bubble>
        ))}
        {front !== undefined && (
          <Bubble
            variant="outline"
            align="end"
            className={stackLayer({ depth: 0 })}
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
                {front.text}
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
                    onSave={(text) => {
                      onEdit(message.id, text)
                      setEditingId(null)
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                </li>
              ) : (
                <QueuedRow
                  key={message.id}
                  message={message}
                  onSendNow={() => onSendNow(message.id)}
                  onEdit={() => setEditingId(message.id)}
                  onRemove={() => onRemove(message.id)}
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
  onSave,
  onCancel
}: {
  readonly initialText: string
  readonly onSave: (text: string) => void
  readonly onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState(initialText)
  const trimmed = text.trim()
  const save = (): void => {
    if (trimmed !== '') onSave(trimmed)
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
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="xs" disabled={trimmed === ''} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}

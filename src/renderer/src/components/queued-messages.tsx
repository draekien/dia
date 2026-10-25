import type { OutgoingMessage } from '@shared/domain/message-queue'
import { PencilIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'

interface QueuedMessagesProps {
  readonly queued: ReadonlyArray<OutgoingMessage>
  readonly held: boolean
  readonly onEdit: (messageId: string, text: string) => void
  readonly onRemove: (messageId: string) => void
}

/**
 * Lists a pane's queued messages above its composer, in send order, with an
 * edit and a remove control on each. `held` changes the caption from "Sends
 * when the turn ends" to "Sends with your next message". `onEdit` receives the
 * trimmed new text, never blank; `onRemove` receives the message id. Renders
 * nothing when `queued` is empty.
 */
export function QueuedMessages({
  queued,
  held,
  onEdit,
  onRemove
}: QueuedMessagesProps): React.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null)
  if (queued.length === 0) return null

  return (
    <section aria-label="Queued messages" className="mb-1.5 flex flex-col gap-1">
      <p className="px-1 text-muted-foreground text-xs">
        {held ? 'Sends with your next message' : 'Sends when the turn ends'}
      </p>
      <ol className="flex flex-col gap-1">
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
            <li
              key={message.id}
              className="group flex items-start gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-2.5"
            >
              <p className="line-clamp-2 flex-1 whitespace-pre-wrap break-words py-0.5 text-sm">
                {message.text}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Edit queued message"
                onClick={() => setEditingId(message.id)}
              >
                <PencilIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Remove queued message"
                onClick={() => onRemove(message.id)}
              >
                <XIcon />
              </Button>
            </li>
          )
        )}
      </ol>
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

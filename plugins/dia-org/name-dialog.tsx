// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label
} from '@dia/renderer-plugin'
import { Loader2Icon } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'

/**
 * A dialog titled `title` with one name field, starting at `initial`. `submitLabel` sends the
 * field's text to `onSubmit`, which resolves to the message to show under the field, or undefined
 * when the dialog should close.
 */
export function NameDialog({
  title,
  initial,
  placeholder,
  submitLabel,
  onSubmit,
  onClose
}: {
  readonly title: string
  readonly initial: string
  readonly placeholder?: string
  readonly submitLabel: string
  readonly onSubmit: (text: string) => Promise<string | undefined>
  readonly onClose: () => void
}) {
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const nameId = useId()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const message = await onSubmit(text).finally(() => setBusy(false))
    if (message === undefined) onClose()
    else setError(message)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={text}
              placeholder={placeholder}
              autoComplete="off"
              aria-invalid={error !== undefined}
              onChange={(event) => {
                setText(event.target.value)
                setError(undefined)
              }}
            />
            {error === undefined ? null : <p className="text-xs text-error">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
              ) : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button
} from '@dia/renderer-plugin'
import { Loader2Icon } from 'lucide-react'
import { useState } from 'react'

/**
 * An alert dialog titled `title` that runs `onConfirm` only on its destructive `confirmLabel`
 * button. `onConfirm` resolves to the reason to show in the dialog, or undefined when the dialog
 * should close.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose
}: {
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly onConfirm: () => Promise<string | undefined>
  readonly onClose: () => void
}) {
  const [reason, setReason] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    setBusy(true)
    const failure = await onConfirm().finally(() => setBusy(false))
    if (failure === undefined) onClose()
    else setReason(failure)
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {reason === undefined ? null : (
          <p role="alert" className="text-sm text-error">
            {reason}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? (
              <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" />
            ) : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

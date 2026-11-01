# dialog

2026-11-01, transformation engine (legacy `new-york`), migrated to `@base-ui/react/dialog`.

## Changed

* `src/renderer/src/components/ui/dialog.tsx`: `Overlay` → `Backdrop`, `Content` → `Popup` (centred, no Positioner); `data-[state=open|closed]:*` → `data-open:*` / `data-closed:*`; `DialogFooter`'s close button `<DialogPrimitive.Close asChild><Button/></…>` → `<DialogPrimitive.Close render={<Button variant="outline" />}>Close</…>`; the stray `data-slot="dialog-portal"` prop passed to `DialogPortal` inside `DialogContent` removed (the wrapper already sets it).
* `src/renderer/src/components/ui/command.tsx` (`CommandDialog`): props typed `Omit<React.ComponentProps<typeof Dialog>, 'children'> & { children?: React.ReactNode }`, because Base UI's Root accepts a render function as `children`, which `cmdk`'s `<Command>` cannot take. Only this type changed in the cmdk wrapper.
* `plugins/chat/attachment-chips.tsx:33`: `DialogTrigger asChild` → `render={<AttachmentTrigger … />}`.
* Leftover scan: clean.

## Left alone

* `command.tsx` otherwise: cmdk is not Radix.

## Behavior changes

* `onOpenChange` receives `(open, eventDetails)`. Existing one-argument handlers are unaffected.
* Focus hooks are now `initialFocus` / `finalFocus` instead of `onOpenAutoFocus` / `onCloseAutoFocus`. No call site used them.

## Verify by hand

* Open Settings, press Escape: the dialog fades out and focus returns to where it was.
* Open About: the close (X) button in the corner closes it.
* Open the command palette: typing filters, Enter runs the item, the dialog closes.

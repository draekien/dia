import { AboutDialog } from '@dia/renderer-plugin'
import { useEffect, useState } from 'react'

const OPEN_ABOUT_EVENT = 'dia:open-about'

/** Opens the About dia dialog that {@link AboutHost} draws. */
export function openAbout(): void {
  window.dispatchEvent(new Event(OPEN_ABOUT_EVENT))
}

/** The About dia dialog, opened by {@link openAbout}. Add it to the dialogs list. */
export function AboutHost() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_ABOUT_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_ABOUT_EVENT, onOpen)
  }, [])

  return <AboutDialog open={open} onOpenChange={setOpen} />
}

import {
  AboutDialog,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useAppVersion
} from '@dia/renderer-plugin'
import { useState } from 'react'

/**
 * The status bar entry that shows the running dia version as `v<version>` and opens the About dia
 * dialog on click. Renders nothing until the version has loaded. Add it to `StatusBarItemsSlot`;
 * it takes no props.
 */
export function VersionEntry() {
  const [aboutOpen, setAboutOpen] = useState(false)
  const version = useAppVersion()
  if (version === undefined) return null
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="font-mono font-normal text-ink-muted"
              onClick={() => setAboutOpen(true)}
            />
          }
        >
          {`v${version}`}
        </TooltipTrigger>
        <TooltipContent side="top">About dia</TooltipContent>
      </Tooltip>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  )
}

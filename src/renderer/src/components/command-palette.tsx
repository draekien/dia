import type { ThemePreference } from '@shared/domain/theme'
import { CheckIcon, InfoIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { type ComponentType, useEffect, useState } from 'react'
import { AboutDialog } from './about-dialog'
import { useTheme } from './theme-provider'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from './ui/command'

interface ThemeItem {
  readonly value: ThemePreference
  readonly label: string
  readonly icon: ComponentType
}

const THEME_ITEMS: ReadonlyArray<ThemeItem> = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon }
]

/**
 * The app-wide command palette, opened with Cmd/Ctrl+K. Currently hosts the
 * theme switcher (light / dark / system); mount it once near the app root,
 * inside a {@link ThemeProvider}. It renders as an overlay dialog, so its
 * position in the tree only needs to be within the provider, not any layout.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((previous) => !previous)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const chooseTheme = (value: ThemePreference) => {
    setTheme(value)
    setOpen(false)
  }

  const openAbout = () => {
    setOpen(false)
    setAboutOpen(true)
  }

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Search for a command to run."
      >
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Theme">
            {THEME_ITEMS.map((item) => (
              <CommandItem
                key={item.value}
                value={`Theme ${item.label}`}
                onSelect={() => chooseTheme(item.value)}
              >
                <item.icon />
                <span>{item.label}</span>
                {theme === item.value && <CheckIcon className="ml-auto" />}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Help">
            <CommandItem value="About dia" onSelect={openAbout}>
              <InfoIcon />
              <span>About dia</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  )
}

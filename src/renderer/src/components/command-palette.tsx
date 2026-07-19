import type { ThemePreference } from '@shared/domain/theme'
import { InfoIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
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
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

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

const OPEN_EVENT = 'dia:open-command-palette'

/**
 * Opens the app-wide command palette from anywhere in the renderer (e.g. a
 * header affordance), without threading its open state through props. Equivalent
 * to pressing the Cmd/Ctrl+K shortcut; a mounted {@link CommandPalette} responds.
 */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

/**
 * The app-wide command palette, opened with Cmd/Ctrl+K or {@link
 * openCommandPalette}. Hosts the About action and a persistent theme switcher
 * (light / dark / system) as a single segmented row; mount it once near the app
 * root, inside a {@link ThemeProvider}. It renders as an overlay dialog, so its
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
    const onOpen = () => setOpen(true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  const openAbout = () => {
    setOpen(false)
    setAboutOpen(true)
  }

  const chooseTheme = (value: string) => {
    if (value === '') return
    setTheme(value as ThemePreference)
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
          <CommandGroup heading="Help">
            <CommandItem value="About dia" onSelect={openAbout}>
              <InfoIcon />
              <span>About dia</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">Theme</span>
          <ToggleGroup
            type="single"
            value={theme}
            onValueChange={chooseTheme}
            variant="outline"
            size="sm"
          >
            {THEME_ITEMS.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value} aria-label={item.label}>
                <item.icon />
                <span>{item.label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </CommandDialog>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  )
}

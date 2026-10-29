import { CodeIcon, InfoIcon, SettingsIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AboutDialog } from './about-dialog'
import { openSettings, type SettingsLocation } from './settings/open-settings'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from './ui/command'

interface SettingsPageLink {
  readonly label: string
  readonly location: SettingsLocation
  readonly keywords: ReadonlyArray<string>
}

const SETTINGS_PAGE_LINKS: ReadonlyArray<SettingsPageLink> = [
  {
    label: 'Settings › General',
    location: { page: 'general' },
    keywords: ['theme', 'dark', 'light', 'send mode', 'queue', 'steer', 'transcript width']
  },
  { label: 'Settings › Adapters', location: { page: 'adapters' }, keywords: ['adapter'] },
  {
    label: 'Settings › Adapters › Claude Code',
    location: { page: 'adapters', adapter: 'claude-code' },
    keywords: ['claude', 'models', 'model', 'health', 'install']
  },
  {
    label: 'Settings › Plugins',
    location: { page: 'plugins' },
    keywords: ['plugin', 'extensions']
  }
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
 * openCommandPalette}. Lists the Settings, About dia and Toggle Developer Tools commands; once
 * the user types, it also lists links to each Settings page (General, Adapters, Claude Code,
 * Plugins) that match the query. Mount it once near the app root; it renders as an overlay dialog,
 * so its position in the tree does not matter.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [query, setQuery] = useState('')

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

  if (!open && query !== '') setQuery('')

  const openAbout = () => {
    setOpen(false)
    setAboutOpen(true)
  }

  const openSettingsAt = (location?: SettingsLocation) => {
    setOpen(false)
    openSettings(location)
  }

  const toggleDevTools = () => {
    setOpen(false)
    window.dia.toggleDevTools()
  }

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Search for a command to run."
      >
        <CommandInput
          placeholder="Type a command or search…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Settings">
            <CommandItem value="Settings" onSelect={() => openSettingsAt()}>
              <SettingsIcon />
              <span>Settings</span>
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Help">
            <CommandItem value="About dia" onSelect={openAbout}>
              <InfoIcon />
              <span>About dia</span>
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Developer">
            <CommandItem value="Toggle Developer Tools" onSelect={toggleDevTools}>
              <CodeIcon />
              <span>Toggle Developer Tools</span>
            </CommandItem>
          </CommandGroup>
          {query.trim() === '' ? null : (
            <CommandGroup heading="Settings pages">
              {SETTINGS_PAGE_LINKS.map((link) => (
                <CommandItem
                  key={link.label}
                  value={link.label}
                  keywords={[...link.keywords]}
                  onSelect={() => openSettingsAt(link.location)}
                >
                  <SettingsIcon />
                  <span>{link.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  )
}

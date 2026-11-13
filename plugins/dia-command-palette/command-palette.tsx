import type { ListEntry } from '@dia/plugin'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  OPEN_COMMAND_PALETTE_EVENT,
  PluginBoundary,
  toast,
  useList
} from '@dia/renderer-plugin'
import { type CommandEntry, CommandsSlot } from '@dia-plugin/dia-command-palette/slots'
import { Effect } from 'effect'
import { useEffect, useState } from 'react'

type Command = ListEntry<CommandEntry>

const groupsOf = (commands: ReadonlyArray<Command>) => {
  const groups = new Map<string, Array<Command>>()
  for (const command of commands) {
    const group = groups.get(command.group)
    if (group === undefined) groups.set(command.group, [command])
    else group.push(command)
  }
  return [...groups.entries()]
}

const runCommand = (command: Command) => {
  Effect.runFork(Effect.logDebug('Running a palette command', { command: command.key }))
  try {
    command.run()
  } catch (error) {
    Effect.runFork(Effect.logError('A palette command failed', { command: command.key, error }))
    toast.add({
      title: `The ${command.key.plugin} plugin's command failed`,
      description: error instanceof Error ? error.message : String(error),
      type: 'error'
    })
  }
}

/**
 * The command palette, opened with Cmd/Ctrl+K or `openCommandPalette`. Lists the commands in
 * `CommandsSlot` by group, and the search-only commands once the user types. Add it to the
 * dialogs list.
 */
export function CommandPalette() {
  const commands = useList(CommandsSlot)
  const [open, setOpen] = useState(false)
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
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    }
  }, [])

  if (!open && query !== '') setQuery('')

  const visible = commands.filter((command) => query.trim() !== '' || command.searchOnly !== true)

  const select = (command: Command) => {
    setOpen(false)
    runCommand(command)
  }

  return (
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
        {groupsOf(visible).map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((command) => (
              <CommandItem
                key={`${command.key.plugin}/${command.key.id}`}
                value={command.label}
                keywords={command.keywords === undefined ? undefined : [...command.keywords]}
                onSelect={() => select(command)}
              >
                {command.icon === undefined ? null : (
                  <PluginBoundary
                    plugin={command.key.plugin}
                    at={CommandsSlot.name}
                    resetKey={command.icon}
                  >
                    <command.icon />
                  </PluginBoundary>
                )}
                <span>{command.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}

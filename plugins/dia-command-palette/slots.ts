import { ListSlot } from '@dia/plugin'
import type { ComponentType } from 'react'

/**
 * A command in the command palette. Commands with the same `group` are listed under that heading;
 * groups follow the lowest `order` among their shown commands. `keywords` also match the query.
 * A command with `searchOnly` is listed only while the query is not empty. Selecting a command
 * closes the palette, then calls `run`.
 */
export interface CommandEntry {
  readonly id: string
  readonly order: number
  readonly group: string
  readonly label: string
  readonly icon?: ComponentType<{ readonly className?: string }>
  readonly keywords?: ReadonlyArray<string>
  readonly searchOnly?: boolean
  readonly run: () => void
}

/** The command palette's commands, declared by the command-palette plugin. Add one with `addEntry(ctx, CommandsSlot, command)`. */
export const CommandsSlot = ListSlot.make<CommandEntry>('command-palette.commands')

import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { describe, expect, it } from 'vitest'
import {
  filterSlashCommands,
  slashCommandCompletion,
  slashCommandQuery,
  wrapHighlight
} from './slash-command-menu'

const command = (name: string, description = '', argumentHint = ''): SlashCommandInfo => ({
  name,
  description,
  argumentHint
})

describe('slashCommandQuery', () => {
  it('returns an empty query for a lone slash', () => {
    expect(slashCommandQuery('/')).toBe('')
  })

  it('returns the partial name while typing a command', () => {
    expect(slashCommandQuery('/cl')).toBe('cl')
  })

  it('returns the full name for a complete command with no trailing space', () => {
    expect(slashCommandQuery('/clear')).toBe('clear')
  })

  it('accepts hyphens in command names', () => {
    expect(slashCommandQuery('/output-style')).toBe('output-style')
  })

  it('closes once a space follows the command (the argument boundary)', () => {
    expect(slashCommandQuery('/clear ')).toBeNull()
  })

  it('closes when the command already has an argument', () => {
    expect(slashCommandQuery('/compact keep the plan')).toBeNull()
  })

  it('does not treat ordinary prose as a query', () => {
    expect(slashCommandQuery('hello there')).toBeNull()
  })

  it('does not match a slash that is not the first character', () => {
    expect(slashCommandQuery('a/b')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(slashCommandQuery('')).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  const commands = [command('clear'), command('compact'), command('config'), command('init')]

  it('returns every command for an empty query', () => {
    expect(filterSlashCommands(commands, '')).toEqual(commands)
  })

  it('keeps only commands whose name starts with the query', () => {
    expect(filterSlashCommands(commands, 'c')).toEqual([
      command('clear'),
      command('compact'),
      command('config')
    ])
  })

  it('narrows further as the query grows', () => {
    expect(filterSlashCommands(commands, 'con')).toEqual([command('config')])
  })

  it('matches case-insensitively', () => {
    expect(filterSlashCommands(commands, 'CL')).toEqual([command('clear')])
  })

  it('matches on prefix only, not a substring mid-name', () => {
    expect(filterSlashCommands(commands, 'ompact')).toEqual([])
  })

  it('preserves the original order of matches', () => {
    const reordered = [command('config'), command('clear'), command('compact')]
    expect(filterSlashCommands(reordered, 'c')).toEqual(reordered)
  })
})

describe('slashCommandCompletion', () => {
  it('prefixes the slash and appends a trailing space', () => {
    expect(slashCommandCompletion(command('clear'))).toBe('/clear ')
  })

  it('produces text that no longer opens the menu', () => {
    expect(slashCommandQuery(slashCommandCompletion(command('compact')))).toBeNull()
  })
})

describe('wrapHighlight', () => {
  it('steps forward within bounds', () => {
    expect(wrapHighlight(0, 1, 3)).toBe(1)
  })

  it('wraps past the end to the first item', () => {
    expect(wrapHighlight(2, 1, 3)).toBe(0)
  })

  it('wraps before the start to the last item', () => {
    expect(wrapHighlight(0, -1, 3)).toBe(2)
  })

  it('steps backward within bounds', () => {
    expect(wrapHighlight(2, -1, 3)).toBe(1)
  })

  it('returns zero for an empty list', () => {
    expect(wrapHighlight(0, 1, 0)).toBe(0)
  })

  it('stays put on a single-item list', () => {
    expect(wrapHighlight(0, 1, 1)).toBe(0)
  })
})

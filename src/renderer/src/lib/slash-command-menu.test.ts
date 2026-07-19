import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { describe, expect, it } from 'vitest'
import {
  activeSlashToken,
  filterSlashCommands,
  slashCommandCompletion,
  wrapHighlight
} from './slash-command-menu'

const command = (name: string, description = '', argumentHint = ''): SlashCommandInfo => ({
  name,
  description,
  argumentHint
})

describe('activeSlashToken', () => {
  it('returns an empty query spanning a lone slash', () => {
    expect(activeSlashToken('/', 1)).toEqual({ query: '', start: 0, end: 1 })
  })

  it('returns the partial name while typing a command', () => {
    expect(activeSlashToken('/cl', 3)).toEqual({ query: 'cl', start: 0, end: 3 })
  })

  it('returns the full name for a complete command with no trailing space', () => {
    expect(activeSlashToken('/clear', 6)).toEqual({ query: 'clear', start: 0, end: 6 })
  })

  it('accepts hyphens in command names', () => {
    expect(activeSlashToken('/output-style', 13)).toEqual({
      query: 'output-style',
      start: 0,
      end: 13
    })
  })

  it('closes once a space follows the command (the argument boundary)', () => {
    expect(activeSlashToken('/clear ', 7)).toBeNull()
  })

  it('closes when the command already has an argument', () => {
    expect(activeSlashToken('/compact keep the plan', 22)).toBeNull()
  })

  it('does not treat ordinary prose as a token', () => {
    expect(activeSlashToken('hello there', 11)).toBeNull()
  })

  it('does not match a slash that is not first on its line', () => {
    expect(activeSlashToken('a/b', 3)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(activeSlashToken('', 0)).toBeNull()
  })

  it('detects a second command on its own line, spanning only that line', () => {
    expect(activeSlashToken('/clear\n/compact', 15)).toEqual({
      query: 'compact',
      start: 7,
      end: 15
    })
  })

  it('targets the line the caret is on, not a later one', () => {
    expect(activeSlashToken('/clear\n/compact', 3)).toEqual({ query: 'clear', start: 0, end: 6 })
  })

  it('is null when the caret sits on a prose line below a command line', () => {
    expect(activeSlashToken('/clear\nhello', 11)).toBeNull()
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

  it('produces a line that no longer opens the menu', () => {
    const completion = slashCommandCompletion(command('compact'))
    expect(activeSlashToken(completion, completion.length)).toBeNull()
  })

  it('splices over the active token range to complete a second command in place', () => {
    const input = '/clear\n/comp'
    const token = activeSlashToken(input, input.length)
    expect(token).not.toBeNull()
    if (token === null) return
    const completion = slashCommandCompletion(command('compact'))
    const next = input.slice(0, token.start) + completion + input.slice(token.end)
    expect(next).toBe('/clear\n/compact ')
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

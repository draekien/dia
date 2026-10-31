import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { describe, expect, it } from 'vitest'
import {
  activeSlashToken,
  activeTriggerToken,
  completeSlashCommand,
  filterSlashCommands,
  splitCommandName,
  wrapHighlight
} from './slash-command-filter'

const command = (name: string, aliases: ReadonlyArray<string> = []): SlashCommandInfo => ({
  name,
  description: '',
  argumentHint: '',
  aliases
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

  it('accepts a plugin-qualified name with a colon', () => {
    expect(activeSlashToken('/productivity-skills:g', 22)).toEqual({
      query: 'productivity-skills:g',
      start: 0,
      end: 22
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

  it('does not match a slash inside a word such as a path', () => {
    expect(activeSlashToken('a/b', 3)).toBeNull()
  })

  it('opens after other text when the slash follows a space', () => {
    expect(activeSlashToken('fix the build then /cl', 22)).toEqual({
      query: 'cl',
      start: 19,
      end: 22
    })
  })

  it('opens at the start of a later line', () => {
    expect(activeSlashToken('line one\n/cl', 12)).toEqual({ query: 'cl', start: 9, end: 12 })
  })

  it('does not open inside a URL', () => {
    const input = 'see https://example.com/pa'
    expect(activeSlashToken(input, input.length)).toBeNull()
  })

  it('queries only up to the caret and spans the rest of the name', () => {
    expect(activeSlashToken('/clear', 3)).toEqual({ query: 'cl', start: 0, end: 6 })
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
    expect(activeSlashToken('/clear\n/compact', 3)).toEqual({ query: 'cl', start: 0, end: 6 })
  })

  it('is null when the caret sits on a prose line below a command line', () => {
    expect(activeSlashToken('/clear\nhello', 11)).toBeNull()
  })
})

describe('activeTriggerToken', () => {
  const mention = { char: '@', isNameChar: (char: string) => /[\w./-]/.test(char) }

  it('uses the trigger character and name characters it is given', () => {
    expect(activeTriggerToken('see @src/ma', 11, mention)).toEqual({
      query: 'src/ma',
      start: 4,
      end: 11
    })
  })

  it('ignores the slash when the trigger is another character', () => {
    expect(activeTriggerToken('/sr', 3, mention)).toBeNull()
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

describe('filterSlashCommands with plugin commands', () => {
  const getAligned = command('productivity-skills:get-aligned', ['get-aligned'])
  const impeccable = command('impeccable:impeccable', ['impeccable'])
  const clear = command('clear')
  const usage = command('usage', ['cost'])
  const commands = [getAligned, impeccable, clear, usage]

  it('finds a plugin skill by its short name', () => {
    expect(filterSlashCommands(commands, 'get')).toEqual([getAligned])
  })

  it('finds a plugin skill by its full name', () => {
    expect(filterSlashCommands(commands, 'productivity-skills:g')).toEqual([getAligned])
  })

  it('finds a plugin skill whose short name repeats the plugin name', () => {
    expect(filterSlashCommands(commands, 'impec')).toEqual([impeccable])
  })

  it('finds a command by an alias', () => {
    expect(filterSlashCommands(commands, 'cos')).toEqual([usage])
  })

  it('leaves a built-in command match unchanged', () => {
    expect(filterSlashCommands(commands, 'cle')).toEqual([clear])
  })

  it('lists name matches before short-name and alias matches', () => {
    const general = command('general')
    expect(filterSlashCommands([getAligned, general], 'ge')).toEqual([general, getAligned])
  })
})

describe('splitCommandName', () => {
  it('splits a plugin-qualified name after the colon', () => {
    expect(splitCommandName('productivity-skills:get-aligned')).toEqual({
      namespace: 'productivity-skills:',
      shortName: 'get-aligned'
    })
  })

  it('gives a built-in command an empty namespace', () => {
    expect(splitCommandName('clear')).toEqual({ namespace: '', shortName: 'clear' })
  })
})

describe('completeSlashCommand with a plugin command', () => {
  it('inserts the full name when the short name was typed', () => {
    const token = activeSlashToken('/get', 4)
    if (token === null) throw new Error('no token')
    expect(
      completeSlashCommand(
        '/get',
        token,
        command('productivity-skills:get-aligned', ['get-aligned'])
      )
    ).toEqual({ value: '/productivity-skills:get-aligned ', caret: 33 })
  })
})

describe('completeSlashCommand', () => {
  const complete = (input: string, caret: number, name: string) => {
    const token = activeSlashToken(input, caret)
    if (token === null) throw new Error(`no token at ${caret} in ${input}`)
    return completeSlashCommand(input, token, command(name))
  }

  it('replaces a lone token with the name and a trailing space', () => {
    expect(complete('/cl', 3, 'clear')).toEqual({ value: '/clear ', caret: 7 })
  })

  it('leaves the caret where the menu is closed', () => {
    const { value, caret } = complete('/comp', 5, 'compact')
    expect(activeSlashToken(value, caret)).toBeNull()
  })

  it('keeps the text before a mid-text token', () => {
    expect(complete('fix the build then /cl', 22, 'clear')).toEqual({
      value: 'fix the build then /clear ',
      caret: 26
    })
  })

  it('keeps one space before the text after the token', () => {
    expect(complete('fix /cl more', 7, 'clear')).toEqual({ value: 'fix /clear more', caret: 11 })
  })

  it('replaces only the token on its own line', () => {
    expect(complete('/clear\n/comp', 12, 'compact')).toEqual({
      value: '/clear\n/compact ',
      caret: 16
    })
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

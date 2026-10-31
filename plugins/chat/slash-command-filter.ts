import type { SlashCommandInfo } from '@shared/domain/slash-command'

/** A trigger-character token at the caret: its filter `query` and the input range
 * (`start`..`end`) it occupies, used to splice in a completion. */
export interface TriggerToken {
  readonly query: string
  readonly start: number
  readonly end: number
}

/** The character that opens a completion menu (`char`) and the characters a name
 * typed after it may contain (`isNameChar`, called with one character at a time). */
export interface TokenTrigger {
  readonly char: string
  readonly isNameChar: (char: string) => boolean
}

const SLASH_TRIGGER: TokenTrigger = { char: '/', isNameChar: (char) => /[\w:-]/.test(char) }

/**
 * Finds the token for `trigger` that the caret is in, so a menu can complete it
 * anywhere in the input. A token is `trigger.char` at the start of the input or
 * right after whitespace (a newline counts), followed by name characters. Text
 * such as `a/b` or a URL is not a token. `query` is the name typed between the
 * trigger character and `caret`; `start`..`end` covers the trigger character and
 * the whole name, including name characters after the caret, and is the range a
 * completion replaces. Returns `null` when the caret is not in a token. `caret`
 * is the textarea `selectionStart`.
 */
export const activeTriggerToken = (
  input: string,
  caret: number,
  trigger: TokenTrigger
): TriggerToken | null => {
  let nameStart = caret
  while (nameStart > 0 && trigger.isNameChar(input[nameStart - 1])) nameStart--
  const start = nameStart - 1
  if (start < 0 || input[start] !== trigger.char) return null
  if (start > 0 && !/\s/.test(input[start - 1])) return null
  let end = caret
  while (end < input.length && trigger.isNameChar(input[end])) end++
  return { query: input.slice(nameStart, caret), start, end }
}

/**
 * The `/` command token at the caret, as {@link activeTriggerToken} finds it for
 * command names (`[\w:-]`, so a plugin prefix such as `productivity-skills:`
 * counts): `fix the build then /cl` yields query `'cl'`, while
 * `/clear ` (after the argument space) and `a/b` yield `null`.
 */
export const activeSlashToken = (input: string, caret: number): TriggerToken | null =>
  activeTriggerToken(input, caret, SLASH_TRIGGER)

/**
 * Splits a command `name` into its plugin `namespace`, which keeps the trailing
 * `:` (`'productivity-skills:'`), and its `shortName` (`'get-aligned'`). A
 * command with no plugin prefix has an empty `namespace`.
 */
export const splitCommandName = (name: string): { namespace: string; shortName: string } => {
  const colon = name.lastIndexOf(':')
  return { namespace: name.slice(0, colon + 1), shortName: name.slice(colon + 1) }
}

/**
 * Selects the commands that `query` matches, case-insensitively: first those
 * whose `name` begins with it, then those matched only by their short name (see
 * {@link splitCommandName}) or one of their `aliases`. Each group keeps the
 * input order. Pass the session's available commands and the `query` of
 * {@link activeSlashToken}; an empty `query` returns every command.
 */
export const filterSlashCommands = (
  commands: ReadonlyArray<SlashCommandInfo>,
  query: string
): ReadonlyArray<SlashCommandInfo> => {
  const needle = query.toLowerCase()
  const starts = (text: string): boolean => text.toLowerCase().startsWith(needle)
  const byName = commands.filter((command) => starts(command.name))
  const byOtherName = commands.filter(
    (command) =>
      !starts(command.name) &&
      (starts(splitCommandName(command.name).shortName) || command.aliases.some(starts))
  )
  return [...byName, ...byOtherName]
}

/**
 * The input after choosing `command` for the active `token` in `input`: the
 * token becomes `/<name> `, the text around it is kept, and one space after the
 * token is dropped so the result has one space between the command and the
 * following text. `caret` is the position just after the inserted space, where
 * arguments are typed; it is outside any token, so the menu closes (see
 * {@link activeSlashToken}).
 */
export const completeSlashCommand = (
  input: string,
  token: TriggerToken,
  command: SlashCommandInfo
): { readonly value: string; readonly caret: number } => {
  const completion = `/${command.name} `
  const after = input.slice(token.end).replace(/^ /, '')
  return {
    value: input.slice(0, token.start) + completion + after,
    caret: token.start + completion.length
  }
}

/**
 * Moves a highlighted index by `delta` within a list of `length`, wrapping past
 * either end so navigation is cyclic. Returns `0` for an empty list. Use to step
 * the menu selection on ArrowUp (`-1`) / ArrowDown (`+1`).
 */
export const wrapHighlight = (index: number, delta: number, length: number): number =>
  length === 0 ? 0 : (((index + delta) % length) + length) % length

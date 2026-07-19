import type { SlashCommandInfo } from '@shared/domain/slash-command'

const SLASH_QUERY = /^\/([\w-]*)$/

/**
 * Extracts the active command query from a pane input, or `null` when the input
 * is not a bare slash token. Matches only a leading `/` followed by command-name
 * characters (`[\w-]`) with nothing else — so `/`, `/cl`, and `/clear` yield
 * `''`, `'cl'`, `'clear'`, while `'/clear '` (trailing space), `'/clear arg'`,
 * and text not starting with `/` yield `null`. Use to decide whether the `/`
 * command menu is open: a non-`null` result is the prefix to filter by.
 */
export const slashCommandQuery = (input: string): string | null => {
  const match = SLASH_QUERY.exec(input)
  return match === null ? null : match[1]
}

/**
 * Selects the commands whose name begins with `query` (case-insensitive),
 * preserving the input order. Pass the session's available commands and the
 * result of {@link slashCommandQuery}; an empty `query` returns every command.
 */
export const filterSlashCommands = (
  commands: ReadonlyArray<SlashCommandInfo>,
  query: string
): ReadonlyArray<SlashCommandInfo> => {
  const needle = query.toLowerCase()
  return commands.filter((command) => command.name.toLowerCase().startsWith(needle))
}

/**
 * The input text produced by choosing `command`: its name prefixed with `/` and
 * a trailing space, so the caret sits ready for arguments and
 * {@link slashCommandQuery} of the result is `null` (closing the menu).
 */
export const slashCommandCompletion = (command: SlashCommandInfo): string => `/${command.name} `

/**
 * Moves a highlighted index by `delta` within a list of `length`, wrapping past
 * either end so navigation is cyclic. Returns `0` for an empty list. Use to step
 * the menu selection on ArrowUp (`-1`) / ArrowDown (`+1`).
 */
export const wrapHighlight = (index: number, delta: number, length: number): number =>
  length === 0 ? 0 : (((index + delta) % length) + length) % length

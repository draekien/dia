import type { SlashCommandInfo } from '@shared/domain/slash-command'

const SLASH_LINE = /^\/([\w-]*)$/

/** The `/` command token active at the caret: its filter `query` and the input
 * range (`start`..`end`) it occupies, used to splice in a completion. */
export interface ActiveSlashToken {
  readonly query: string
  readonly start: number
  readonly end: number
}

/**
 * Finds the `/` command token being typed on the line that contains `caret`, so
 * the popover can assist several commands in one message (one per line). A line
 * qualifies only when it is exactly a leading `/` followed by command-name
 * characters (`[\w-]`) — so `/`, `/cl`, `/clear` yield queries `''`, `'cl'`,
 * `'clear'`, while a line with a trailing space, an argument (`/clear arg`), or
 * ordinary prose yields `null`. Returns the query plus the line's `start`/`end`
 * range for {@link slashCommandCompletion} to replace, or `null` when the caret's
 * line is not a bare command token. `caret` is the textarea `selectionStart`.
 */
export const activeSlashToken = (input: string, caret: number): ActiveSlashToken | null => {
  const start = caret === 0 ? 0 : input.lastIndexOf('\n', caret - 1) + 1
  const nextNewline = input.indexOf('\n', caret)
  const end = nextNewline === -1 ? input.length : nextNewline
  const match = SLASH_LINE.exec(input.slice(start, end))
  return match === null ? null : { query: match[1], start, end }
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
 * The line text produced by choosing `command`: its name prefixed with `/` and
 * a trailing space, so the caret sits ready for arguments and the line is no
 * longer a bare token, closing the menu (see {@link activeSlashToken}). Splice
 * this over the active token's `start`..`end` range.
 */
export const slashCommandCompletion = (command: SlashCommandInfo): string => `/${command.name} `

/**
 * Moves a highlighted index by `delta` within a list of `length`, wrapping past
 * either end so navigation is cyclic. Returns `0` for an empty list. Use to step
 * the menu selection on ArrowUp (`-1`) / ArrowDown (`+1`).
 */
export const wrapHighlight = (index: number, delta: number, length: number): number =>
  length === 0 ? 0 : (((index + delta) % length) + length) % length

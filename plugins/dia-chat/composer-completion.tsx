import type { InputGroupTextarea } from '@dia/renderer-plugin'
import { PathAttachment, type ProjectEntry } from '@shared/domain/attachment'
import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { Effect } from 'effect'
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useMemo,
  useState
} from 'react'
import {
  activeMentionToken,
  entryPath,
  filterProjectEntries,
  removeToken
} from './attachment-draft'
import { PathMenu, pathMenuListboxId, pathMenuOptionId } from './path-menu'
import {
  activeSlashToken,
  completeSlashCommand,
  filterSlashCommands,
  type TriggerToken,
  wrapHighlight
} from './slash-command-filter'
import { SlashCommandMenu, slashMenuListboxId, slashMenuOptionId } from './slash-command-menu'
import { useProjectEntries } from './use-composer-attachments'

/** The textarea props {@link useComposerCompletion} sets: the combobox role and ARIA state, and caret tracking. */
export type ComposerTextareaProps = Pick<
  ComponentProps<typeof InputGroupTextarea>,
  | 'role'
  | 'aria-expanded'
  | 'aria-controls'
  | 'aria-autocomplete'
  | 'aria-activedescendant'
  | 'onSelect'
  | 'onChange'
>

const isConfirmKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
  (event.key === 'Enter' || event.key === 'Tab') &&
  !event.shiftKey &&
  !event.nativeEvent.isComposing

/**
 * `/` command and `@` path completion for a composer textarea. `text` and `setText` are the
 * composer's value; `commands` the commands to offer; `cwd` the directory paths are listed from,
 * or `null` to offer no `@` menu; `listId` makes the menus' element ids unique on the page;
 * `onPath` receives a chosen path. A `text` changed from outside, such as a reset after a send,
 * closes menus whose trigger is no longer in it.
 */
export function useComposerCompletion(input: {
  readonly text: string
  readonly setText: (text: string) => void
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>
  readonly commands: ReadonlyArray<SlashCommandInfo>
  readonly cwd: string | null
  readonly listId: string
  readonly onPath: (attachment: PathAttachment) => void
}): {
  /** The open menu, to render directly above the input group. */
  readonly menu: ReactNode
  /** Spread onto the textarea; its `onChange` calls `setText`, then tracks the caret and reopens dismissed menus. */
  readonly textareaProps: ComposerTextareaProps
  /** Call first in the textarea's `onKeyDown`; `true` when it handled the key. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
} {
  const { text, setText, textareaRef, commands, cwd, listId, onPath } = input
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [caret, setCaret] = useState(0)
  const [pathHighlight, setPathHighlight] = useState(0)
  const [pathDismissed, setPathDismissed] = useState(false)

  const mention = cwd === null ? null : activeMentionToken(text, caret)
  const projectEntries = useProjectEntries(cwd ?? '', mention !== null)
  const mentionQuery = mention?.query ?? null
  const pathMatches = useMemo(
    () => (mentionQuery === null ? [] : filterProjectEntries(projectEntries.entries, mentionQuery)),
    [projectEntries.entries, mentionQuery]
  )

  const token = activeSlashToken(text, caret)
  const matches = token === null ? [] : filterSlashCommands(commands, token.query)
  const isMenuOpen = matches.length > 0 && !slashDismissed
  const highlight = wrapHighlight(slashHighlight, 0, matches.length)
  const isPathMenuOpen = mention !== null && !isMenuOpen && !pathDismissed
  const pathIndex = wrapHighlight(pathHighlight, 0, pathMatches.length)

  const placeCaret = (nextCaret: number): void => {
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (element === null) return
      element.selectionStart = nextCaret
      element.selectionEnd = nextCaret
      setCaret(nextCaret)
    })
  }
  const selectPath = (entry: ProjectEntry, at: TriggerToken): void => {
    const { value, caret: nextCaret } = removeToken(text, at)
    setText(value)
    setPathHighlight(0)
    Effect.runSync(Effect.logDebug('Completing a path', { path: entry.path }))
    onPath(PathAttachment.make({ path: entryPath(cwd ?? '', entry), kind: entry.kind }))
    placeCaret(nextCaret)
  }
  const selectCommand = (command: SlashCommandInfo, at: TriggerToken): void => {
    const { value, caret: nextCaret } = completeSlashCommand(text, at, command)
    setText(value)
    setSlashHighlight(0)
    Effect.runSync(Effect.logDebug('Completing a slash command', { command: command.name }))
    placeCaret(nextCaret)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (isPathMenuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setPathHighlight(
          wrapHighlight(pathIndex, event.key === 'ArrowDown' ? 1 : -1, pathMatches.length)
        )
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setPathDismissed(true)
        return true
      }
      if (isConfirmKey(event)) {
        const entry = pathMatches[pathIndex]
        if (entry !== undefined && mention !== null) {
          event.preventDefault()
          selectPath(entry, mention)
          return true
        }
      }
    }
    if (isMenuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashHighlight(wrapHighlight(highlight, 1, matches.length))
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashHighlight(wrapHighlight(highlight, -1, matches.length))
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashDismissed(true)
        return true
      }
      if (isConfirmKey(event)) {
        event.preventDefault()
        const command = matches[highlight]
        if (command !== undefined && token !== null) selectCommand(command, token)
        return true
      }
    }
    return false
  }

  const menu = (
    <>
      {isPathMenuOpen && mention !== null && (
        <PathMenu
          paneId={listId}
          entries={pathMatches}
          loading={projectEntries.loading}
          highlightedIndex={pathIndex}
          onSelect={(entry) => selectPath(entry, mention)}
          onHighlight={setPathHighlight}
        />
      )}
      {isMenuOpen && token !== null && (
        <SlashCommandMenu
          paneId={listId}
          commands={matches}
          highlightedIndex={highlight}
          onSelect={(command) => selectCommand(command, token)}
          onHighlight={setSlashHighlight}
        />
      )}
    </>
  )

  const textareaProps: ComposerTextareaProps = {
    role: 'combobox',
    'aria-expanded': isMenuOpen || isPathMenuOpen,
    'aria-controls': isPathMenuOpen ? pathMenuListboxId(listId) : slashMenuListboxId(listId),
    'aria-autocomplete': 'list',
    'aria-activedescendant': isMenuOpen
      ? slashMenuOptionId(listId, highlight)
      : isPathMenuOpen && pathMatches.length > 0
        ? pathMenuOptionId(listId, pathIndex)
        : undefined,
    onSelect: (event) => setCaret(event.currentTarget.selectionStart),
    onChange: (event) => {
      setText(event.target.value)
      setCaret(event.target.selectionStart)
      setSlashDismissed(false)
      setSlashHighlight(0)
      setPathDismissed(false)
      setPathHighlight(0)
    }
  }

  return { menu, textareaProps, onKeyDown }
}

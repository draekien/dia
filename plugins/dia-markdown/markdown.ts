import { ServiceKey } from '@dia/plugin'
import type { ComponentType } from 'react'

/**
 * Props of dia's Markdown block. `content` is the raw Markdown, which may be a partially streamed
 * response; `className` is appended to the typeset wrapper for context-specific spacing or colour.
 */
export interface MarkdownProps {
  readonly content: string
  readonly className?: string
}

/**
 * dia's Markdown renderer, which the `dia-markdown` plugin provides. Read it with
 * `useProvided(MarkdownKey)`; it is `undefined` while no plugin provides it, so a reader shows the
 * plain text then.
 */
export const MarkdownKey = ServiceKey.make(
  'markdown',
  (value): value is ComponentType<MarkdownProps> => typeof value === 'function'
)

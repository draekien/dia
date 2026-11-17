import { cn, useProvided } from '@dia/renderer-plugin'
import { MarkdownKey, type MarkdownProps } from '@dia-plugin/dia-markdown/markdown'

/**
 * Renders `content` with the Markdown renderer `dia-markdown` provides, or as plain text with its
 * line breaks kept while none is provided. `className` is appended to the wrapper.
 */
export function Markdown({ content, className }: MarkdownProps): React.JSX.Element {
  const Provided = useProvided(MarkdownKey)
  if (Provided !== undefined) return <Provided content={content} className={className} />
  return <p className={cn('whitespace-pre-wrap', className)}>{content}</p>
}

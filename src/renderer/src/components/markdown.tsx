import { cn } from '@renderer/lib/utils'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeHighlightLines from 'rehype-highlight-code-lines'
import remarkGfm from 'remark-gfm'

const typesetClassName = 'typeset typeset-docs max-w-[75ch]'

/**
 * Renders a string of GitHub-flavoured Markdown as dia's standard prose block:
 * the shared `typeset` styling, syntax-highlighted code with line numbers, and
 * links opening in a new tab. Pass the raw markdown `content`; `className`
 * appends to the typeset wrapper for context-specific spacing or colour.
 */
export function Markdown({
  content,
  className
}: {
  content: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn(typesetClassName, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
          [rehypeHighlightLines, { showLineNumbers: true }]
        ]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { createHighlighter } from '@tanstack/highlight/core'
import { c } from '@tanstack/highlight/languages/c'
import { cpp } from '@tanstack/highlight/languages/cpp'
import { csharp } from '@tanstack/highlight/languages/csharp'
import { css } from '@tanstack/highlight/languages/css'
import { diff } from '@tanstack/highlight/languages/diff'
import { dockerfile } from '@tanstack/highlight/languages/dockerfile'
import { go } from '@tanstack/highlight/languages/go'
import { graphql } from '@tanstack/highlight/languages/graphql'
import { html } from '@tanstack/highlight/languages/html'
import { ini } from '@tanstack/highlight/languages/ini'
import { java } from '@tanstack/highlight/languages/java'
import { js } from '@tanstack/highlight/languages/js'
import { json } from '@tanstack/highlight/languages/json'
import { jsx } from '@tanstack/highlight/languages/jsx'
import { kotlin } from '@tanstack/highlight/languages/kotlin'
import { lua } from '@tanstack/highlight/languages/lua'
import { makefile } from '@tanstack/highlight/languages/makefile'
import { markdown } from '@tanstack/highlight/languages/markdown'
import { php } from '@tanstack/highlight/languages/php'
import { plaintext } from '@tanstack/highlight/languages/plaintext'
import { powershell } from '@tanstack/highlight/languages/powershell'
import { python } from '@tanstack/highlight/languages/python'
import { ruby } from '@tanstack/highlight/languages/ruby'
import { rust } from '@tanstack/highlight/languages/rust'
import { scss } from '@tanstack/highlight/languages/scss'
import { shell } from '@tanstack/highlight/languages/shell'
import { sql } from '@tanstack/highlight/languages/sql'
import { swift } from '@tanstack/highlight/languages/swift'
import { toml } from '@tanstack/highlight/languages/toml'
import { ts } from '@tanstack/highlight/languages/ts'
import { tsx } from '@tanstack/highlight/languages/tsx'
import { yaml } from '@tanstack/highlight/languages/yaml'
import { createTanStackMarkdownHighlighter } from '@tanstack/highlight/markdown'
import type { LinkNode, MarkdownExtension, UrlTransform } from '@tanstack/markdown'
import { streamingMarkdownExtension } from '@tanstack/markdown/extensions/streaming'
import {
  type MarkdownComponentProps,
  type MarkdownComponents,
  Markdown as TanStackMarkdown
} from '@tanstack/markdown/react'
import { ImageIcon } from 'lucide-react'
import { memo, useState } from 'react'

const typesetClassName = 'typeset typeset-docs max-w-[75ch]'

const highlighter = createTanStackMarkdownHighlighter(
  createHighlighter({
    languages: [
      plaintext,
      c,
      cpp,
      csharp,
      css,
      diff,
      dockerfile,
      go,
      graphql,
      html,
      ini,
      java,
      js,
      json,
      jsx,
      kotlin,
      lua,
      makefile,
      markdown,
      php,
      powershell,
      python,
      ruby,
      rust,
      scss,
      shell,
      sql,
      swift,
      toml,
      ts,
      tsx,
      yaml
    ]
  })
)

const bareUrlPattern = /^https?:\/\/[^\s<]+/
const angleUrlPattern = /^<(https?:\/\/[^\s<>]+)>/
const trailingPunctuation = '.,:;!?\'"*_~'

function count(text: string, character: string): number {
  return text.split(character).length - 1
}

function trimTrailingPunctuation(url: string): string {
  let end = url.length
  while (end > 0) {
    const last = url[end - 1] as string
    const unbalancedParen =
      last === ')' && count(url.slice(0, end), ')') > count(url.slice(0, end), '(')
    if (!trailingPunctuation.includes(last) && !unbalancedParen) break
    end--
  }
  return url.slice(0, end)
}

function hasHost(url: string): boolean {
  return url.length > url.indexOf('//') + 2
}

function urlLink(url: string): LinkNode {
  return { type: 'link', href: url, children: [{ type: 'text', value: url }] }
}

const autolinkExtension: MarkdownExtension = {
  name: 'autolink',
  inlineParser: {
    markers: 'h<',
    parse({ source, index, inLink }) {
      if (inLink) return undefined
      const rest = source.slice(index)
      const angle = angleUrlPattern.exec(rest)
      if (angle) return { node: urlLink(angle[1] as string), length: angle[0].length }
      if (/[\p{L}\p{N}]/u.test(source[index - 1] ?? '')) return undefined
      const bare = bareUrlPattern.exec(rest)
      if (!bare) return undefined
      const url = trimTrailingPunctuation(bare[0])
      if (!hasHost(url)) return undefined
      return { node: urlLink(url), length: url.length }
    }
  }
}

const extensions = [streamingMarkdownExtension(), autolinkExtension]

function isRemoteImage(url: string): boolean {
  return URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol)
}

const urlTransform: UrlTransform = (_url, kind, defaultUrl) =>
  kind === 'image' && !isRemoteImage(defaultUrl) ? null : defaultUrl

function RemoteImage({ src, alt, title }: MarkdownComponentProps<'img'>): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  if (loaded) return <img src={src} alt={alt} title={title} />
  return (
    <Button variant="outline" size="xs" title={src} onClick={() => setLoaded(true)}>
      <ImageIcon data-icon="inline-start" />
      Load image from {new URL(String(src)).host}
    </Button>
  )
}

const components = {
  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
  img: RemoteImage
} satisfies MarkdownComponents

/**
 * Renders a string of Markdown as dia's standard prose block: the shared
 * `typeset` styling, syntax-highlighted code with line numbers, links
 * opening in a new tab, and remote images that load only after the user clicks
 * them. Pass the raw markdown `content`, which may be a
 * partially streamed response; `className` appends to the typeset wrapper for
 * context-specific spacing or colour.
 */
export const Markdown = memo(function Markdown({
  content,
  className
}: {
  content: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn(typesetClassName, className)}>
      <TanStackMarkdown
        extensions={extensions}
        frontmatter={false}
        headingIds={false}
        highlighter={highlighter}
        urlTransform={urlTransform}
        codeLineNumbers
        components={components}
      >
        {content}
      </TanStackMarkdown>
    </div>
  )
})

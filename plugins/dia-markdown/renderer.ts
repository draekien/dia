import type { PluginServices, PluginSetup } from '@dia/plugin'
import { Effect } from 'effect'
import { createElement } from 'react'
import { MarkdownKey, type MarkdownProps } from './markdown'
import { Markdown } from './markdown-view'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(MarkdownKey, (props: MarkdownProps) => createElement(Markdown, props))
    yield* Effect.logDebug('Markdown renderer provided', { key: MarkdownKey.name })
  })

export default setup

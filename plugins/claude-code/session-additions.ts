import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { SessionAdditions } from '@dia/plugin'

/**
 * The Agent SDK query options that enact `additions`: the Claude Code system prompt, with
 * `systemPromptAppend` appended when it is not empty, and one local plugin per entry of
 * `pluginPaths`. Spread the result into a query's `options`.
 */
export const sessionAdditionsOptions = (
  additions: SessionAdditions
): Pick<Options, 'systemPrompt' | 'plugins'> => ({
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    ...(additions.systemPromptAppend === '' ? {} : { append: additions.systemPromptAppend })
  },
  ...(additions.pluginPaths.length === 0
    ? {}
    : { plugins: additions.pluginPaths.map((path) => ({ type: 'local' as const, path })) })
})

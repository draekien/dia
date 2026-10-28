import { type Query, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Effect, Queue } from 'effect'
import { installQueryOptions } from './claude-install'
import { openPromptInput } from './session'

/**
 * Starts the Claude Code install at `path` in `cwd` as a query that starts no turn, writes no
 * transcript and starts no MCP server, runs `use` on it, and closes it whatever the outcome.
 * Use it to read what the install reports (models, account) without a conversation.
 */
export const withIdleQuery = <A, E>(
  path: string,
  cwd: string,
  use: (idle: Query) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const input = yield* openPromptInput(yield* Queue.unbounded<SDKUserMessage>())
      const idle = query({
        prompt: input.prompts,
        options: { cwd, persistSession: false, strictMcpConfig: true, ...installQueryOptions(path) }
      })
      return { input, idle }
    }),
    ({ idle }) => use(idle),
    ({ input, idle }) =>
      input.end.pipe(
        Effect.andThen(Effect.sync(() => idle.close())),
        Effect.andThen(Effect.logDebug('Closed an idle query'))
      )
  )

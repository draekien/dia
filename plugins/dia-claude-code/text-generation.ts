import { type Query, query } from '@anthropic-ai/claude-agent-sdk'
import type { EffortLevel, ModelCatalogState } from '@dia/plugin'
import {
  type TextGeneration,
  TextGenerationFailed,
  type TextGenerationRequest
} from '@dia-plugin/dia-agent-adapters/registry'
import { Effect, Option, Stream } from 'effect'
import { type ClaudeInstall, installQueryOptions } from './claude-install'
import { messageOf } from './idle-query'
import { type ThinkingOptions, thinkingOptions } from './thinking-options'

const DEFAULT_MODEL = 'haiku'

const DISABLED_THINKING: ThinkingOptions = { thinking: { type: 'disabled' } }

const failed = (reason: string) => new TextGenerationFailed({ reason })

const effortOptions = (
  state: Option.Option<ModelCatalogState>,
  model: string,
  effort: EffortLevel
): ThinkingOptions =>
  Option.exists(
    state,
    (current) =>
      current._tag === 'Ready' &&
      current.models.some(
        (option) => option.value === model && option.effortLevels.includes(effort)
      )
  )
    ? thinkingOptions(effort)
    : DISABLED_THINKING

const readAnswer = (running: Query) =>
  Stream.fromAsyncIterable(running, (cause) =>
    failed(`Claude Code stopped before answering: ${messageOf(cause)}`)
  ).pipe(
    Stream.filter((message) => message.type === 'result'),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.flatMap((result) => {
      if (result === undefined) return Effect.fail(failed('Claude Code ended without a result'))
      if (result.subtype !== 'success' || result.is_error) {
        const detail = result.subtype === 'success' ? result.result : result.errors.join('; ')
        return Effect.fail(failed(`Claude Code answered with an error: ${detail}`))
      }
      const text = result.result.trim()
      return text === ''
        ? Effect.fail(failed('Claude Code answered with no text'))
        : Effect.succeed(text)
    })
  )

/**
 * The {@link TextGeneration} of Claude Code: `defaultModel` is `haiku`. `generate` runs the
 * install `install` resolves as one query in `dataDir` that has no tools, writes no transcript and
 * starts no MCP server, and returns the trimmed answer. The request's effort is sent only when the
 * first state of `catalog.models()` is `Ready` and lists it for the request's model; otherwise
 * thinking is disabled and no effort is sent. It fails with `TextGenerationFailed` when no install
 * is found, the query errors, or the answer is empty. Interrupting `generate` closes the query.
 */
export const makeClaudeCodeTextGeneration = ({
  install,
  dataDir,
  catalog
}: {
  readonly install: ClaudeInstall
  readonly dataDir: string
  readonly catalog: { readonly models: () => Stream.Stream<ModelCatalogState> }
}): TextGeneration => ({
  defaultModel: DEFAULT_MODEL,
  generate: Effect.fn('ClaudeCodeTextGeneration.generate')(function* (
    request: TextGenerationRequest
  ) {
    const path = yield* install.resolve
    if (Option.isNone(path)) {
      return yield* failed('Claude Code is not installed')
    }
    const state = yield* Stream.runHead(catalog.models())
    const thinking = effortOptions(state, request.model, request.effort)
    yield* Effect.logDebug('Generating text with Claude Code', {
      model: request.model,
      effort: thinking.effort
    })
    const text = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () =>
          query({
            prompt: request.input,
            options: {
              systemPrompt: request.instructions,
              model: request.model,
              ...thinking,
              tools: [],
              persistSession: false,
              strictMcpConfig: true,
              settingSources: [],
              maxTurns: 1,
              cwd: dataDir,
              ...installQueryOptions(path.value)
            }
          }),
        catch: (cause) => failed(`Claude Code could not start: ${messageOf(cause)}`)
      }),
      readAnswer,
      (running) =>
        Effect.sync(() => running.close()).pipe(
          Effect.andThen(Effect.logDebug('Closed a text generation query'))
        )
    )
    yield* Effect.logDebug('Generated text with Claude Code', { length: text.length })
    return text
  })
})

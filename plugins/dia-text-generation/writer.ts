import { type AgentName, agentNameFromTitle } from '@dia/plugin'
import type { AgentAdapter, TextGeneration } from '@dia-plugin/dia-agent-adapters/registry'
import { Duration, Effect, Option } from 'effect'
import { type TextGenerationSettings, TitleNotGenerated } from './calls'

const TITLE_TIMEOUT = Duration.seconds(30)

const TITLE_INSTRUCTIONS = [
  'You write the title of a conversation between a user and an AI coding assistant.',
  'The user message holds the conversation.',
  'Answer with a short title of at most 6 words.',
  'Use no quotation marks and no trailing punctuation.',
  'Answer in plain text only: no markdown, no explanation, nothing but the title.'
].join('\n')

const SURROUNDING = '"\'`“”‘’'

const titleLineOf = (answer: string): string => {
  const line = answer
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  if (line === undefined) return ''
  return line
    .replace(new RegExp(`^[${SURROUNDING}]+`), '')
    .replace(new RegExp(`[${SURROUNDING}.]+$`), '')
    .trim()
}

interface Chosen {
  readonly adapterId: string
  readonly textGeneration: TextGeneration
  readonly model: string
  readonly effort: TextGenerationSettings['effort']
}

/** Writes a thread title from conversation text. */
export interface TitleWriter {
  /**
   * Writes a title for `conversation`, the text of the user's and assistant's messages so far.
   * Uses the saved adapter when it is registered with text generation; otherwise the first
   * registered adapter with text generation, with its default model, and logs a warning naming
   * it. Fails with `TitleNotGenerated` when no adapter offers text generation, the call fails or
   * takes longer than 30 seconds, or the answer holds no usable title.
   */
  readonly title: (conversation: string) => Effect.Effect<AgentName, TitleNotGenerated>
}

/**
 * Builds the {@link TitleWriter} that reads the saved settings from `settings` and the registered
 * adapters from `adapters` on every title, so a change applies to the next one.
 */
export const makeTitleWriter = (deps: {
  readonly settings: Effect.Effect<TextGenerationSettings>
  readonly adapters: Effect.Effect<ReadonlyArray<AgentAdapter>>
}): TitleWriter => {
  const choose = Effect.fnUntraced(function* (): Effect.fn.Return<Chosen, TitleNotGenerated> {
    const saved = yield* deps.settings
    const registered = yield* deps.adapters
    const savedAdapter = registered.find(
      (adapter) => adapter.id === saved.adapter && Option.isSome(adapter.textGeneration)
    )
    if (savedAdapter !== undefined && Option.isSome(savedAdapter.textGeneration)) {
      return {
        adapterId: savedAdapter.id,
        textGeneration: savedAdapter.textGeneration.value,
        model: saved.model,
        effort: saved.effort
      }
    }
    for (const adapter of registered) {
      if (Option.isSome(adapter.textGeneration)) {
        yield* Effect.logWarning(
          'The saved text generation adapter is not available; using the first adapter with text generation',
          { saved: saved.adapter, fallback: adapter.id }
        )
        return {
          adapterId: adapter.id,
          textGeneration: adapter.textGeneration.value,
          model: adapter.textGeneration.value.defaultModel,
          effort: saved.effort
        }
      }
    }
    return yield* new TitleNotGenerated({ reason: 'No adapter offers text generation' })
  })

  const generate = Effect.fnUntraced(function* (
    chosen: Chosen,
    conversation: string
  ): Effect.fn.Return<string, TitleNotGenerated> {
    yield* Effect.logDebug('Generating a title', {
      adapter: chosen.adapterId,
      model: chosen.model,
      effort: chosen.effort
    })
    return yield* chosen.textGeneration
      .generate({
        instructions: TITLE_INSTRUCTIONS,
        input: conversation,
        model: chosen.model,
        effort: chosen.effort
      })
      .pipe(
        Effect.timeout(TITLE_TIMEOUT),
        Effect.catchTag('TextGenerationFailed', (failure) =>
          Effect.fail(new TitleNotGenerated({ reason: failure.reason }))
        ),
        Effect.catchTag('TimeoutError', () =>
          Effect.fail(
            new TitleNotGenerated({
              reason: `${chosen.adapterId} took longer than ${Duration.toSeconds(TITLE_TIMEOUT)} seconds to write a title`
            })
          )
        )
      )
  })

  const title = Effect.fnUntraced(
    function* (conversation: string): Effect.fn.Return<AgentName, TitleNotGenerated> {
      const chosen = yield* choose()
      const answer = yield* generate(chosen, conversation)
      yield* Effect.logDebug('Received a title answer', { answerLength: answer.length })
      const name = agentNameFromTitle(titleLineOf(answer))
      if (Option.isNone(name)) {
        return yield* new TitleNotGenerated({ reason: 'The answer held no usable title' })
      }
      return name.value
    },
    Effect.tapError((error) =>
      Effect.logWarning('No title was generated', { reason: error.reason })
    )
  )

  return { title }
}

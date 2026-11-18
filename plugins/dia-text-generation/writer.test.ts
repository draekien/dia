import type { TextGenerationRequest } from '@dia-plugin/dia-agent-adapters/registry'
import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import type { TextGenerationSettings } from './calls'
import {
  adapterWithoutText,
  adapterWithText,
  answering,
  captureLogs,
  failing
} from './text-generation.fake'
import { makeTitleWriter } from './writer'

const SAVED: TextGenerationSettings = { adapter: 'claude', model: 'sonnet', effort: 'high' }

const writerOver = (
  adapters: ReadonlyArray<ReturnType<typeof adapterWithText>>,
  settings: TextGenerationSettings = SAVED
) => makeTitleWriter({ settings: Effect.succeed(settings), adapters: Effect.succeed(adapters) })

const failureOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect)

describe('TitleWriter', () => {
  it.effect('sends the saved model and effort of the saved adapter with the conversation', () =>
    Effect.gen(function* () {
      const requests: Array<TextGenerationRequest> = []
      const writer = writerOver([
        adapterWithText('claude', 'haiku', answering('A title'), requests)
      ])

      yield* writer.title('User: hello')

      assert.strictEqual(requests.length, 1)
      assert.deepInclude(requests[0], { model: 'sonnet', effort: 'high', input: 'User: hello' })
    })
  )

  it.effect('asks for a title of at most 6 words, plain text only', () =>
    Effect.gen(function* () {
      const requests: Array<TextGenerationRequest> = []
      const writer = writerOver([
        adapterWithText('claude', 'haiku', answering('A title'), requests)
      ])

      yield* writer.title('User: hello')

      assert.include(requests[0]?.instructions, '6 words')
      assert.include(requests[0]?.instructions, 'plain text')
    })
  )

  it.effect(
    'uses the first adapter with text generation and its default model when the saved adapter is not registered',
    () => {
      const { logs, layer } = captureLogs()
      return Effect.gen(function* () {
        const requests: Array<TextGenerationRequest> = []
        const writer = writerOver([
          adapterWithoutText('aaa'),
          adapterWithText('bbb', 'bbb-default', answering('Fallback title'), requests),
          adapterWithText('ccc', 'ccc-default', answering('Other'))
        ])

        const name = yield* writer.title('User: hello')

        assert.strictEqual(name, 'Fallback title')
        assert.deepInclude(requests[0], { model: 'bbb-default', effort: 'high' })
        const warnings = logs.filter((log) => log.level === 'Warn')
        assert.strictEqual(warnings.length, 1)
        assert.include(warnings[0]?.text, 'bbb')
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect('does not use the saved adapter when it is registered without text generation', () =>
    Effect.gen(function* () {
      const requests: Array<TextGenerationRequest> = []
      const writer = makeTitleWriter({
        settings: Effect.succeed(SAVED),
        adapters: Effect.succeed([
          adapterWithoutText('claude'),
          adapterWithText('other', 'other-default', answering('Title'), requests)
        ])
      })

      yield* writer.title('User: hello')

      assert.strictEqual(requests[0]?.model, 'other-default')
    })
  )

  it.effect('fails with TitleNotGenerated when no adapter offers text generation', () =>
    Effect.gen(function* () {
      const writer = makeTitleWriter({
        settings: Effect.succeed(SAVED),
        adapters: Effect.succeed([adapterWithoutText('claude')])
      })

      const error = yield* failureOf(writer.title('User: hello'))

      assert.strictEqual(error._tag, 'TitleNotGenerated')
    })
  )

  it.effect(
    'fails with TitleNotGenerated carrying the reason and logs a warning when generate fails',
    () => {
      const { logs, layer } = captureLogs()
      return Effect.gen(function* () {
        const writer = writerOver([
          adapterWithText('claude', 'haiku', failing('Claude Code is not installed'))
        ])

        const error = yield* failureOf(writer.title('User: hello'))

        assert.strictEqual(error.reason, 'Claude Code is not installed')
        assert.isTrue(logs.some((log) => log.level === 'Warn'))
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect('fails with TitleNotGenerated when generate does not answer within 30 seconds', () =>
    Effect.gen(function* () {
      const writer = writerOver([adapterWithText('claude', 'haiku', () => Effect.never)])

      const fiber = yield* Effect.forkChild(Effect.flip(writer.title('User: hello')))
      yield* TestClock.adjust(Duration.seconds(29))
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust(Duration.seconds(1))
      const error = yield* Fiber.join(fiber)

      assert.strictEqual(error._tag, 'TitleNotGenerated')
    })
  )

  it.effect('interrupts the generate call when it times out', () =>
    Effect.gen(function* () {
      const interrupted = { value: false }
      const writer = writerOver([
        adapterWithText('claude', 'haiku', () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted.value = true
              })
            )
          )
        )
      ])

      const fiber = yield* Effect.forkChild(Effect.flip(writer.title('User: hello')))
      yield* TestClock.adjust(Duration.seconds(30))
      yield* Fiber.join(fiber)

      assert.isTrue(interrupted.value)
    })
  )

  const cases: ReadonlyArray<readonly [string, string, string | undefined]> = [
    ['strips surrounding double quotes', '"Fix the login bug"', 'Fix the login bug'],
    ['strips surrounding backticks', '`Fix the login bug`', 'Fix the login bug'],
    ['strips a trailing period', 'Fix the login bug.', 'Fix the login bug'],
    ['strips quotes and a trailing period together', '"Fix the login bug."', 'Fix the login bug'],
    [
      'keeps only the first non-empty line',
      '\n\n  Fix the login bug  \nBecause of reasons',
      'Fix the login bug'
    ],
    ['accepts CRLF line breaks', 'Fix the bug\r\nsecond', 'Fix the bug'],
    ['keeps inner punctuation', 'Fix: the login bug', 'Fix: the login bug'],
    ['has no title for an empty answer', '', undefined],
    ['has no title for whitespace only', ' \n\t \n', undefined],
    ['has no title for quotes only', '""', undefined]
  ]
  for (const [behaviour, answer, expected] of cases) {
    it.effect(`${behaviour}`, () =>
      Effect.gen(function* () {
        const writer = writerOver([adapterWithText('claude', 'haiku', answering(answer))])

        if (expected === undefined) {
          const error = yield* failureOf(writer.title('User: hello'))
          assert.strictEqual(error._tag, 'TitleNotGenerated')
        } else {
          assert.strictEqual(yield* writer.title('User: hello'), expected)
        }
      })
    )
  }

  it.effect('cuts a title longer than 64 characters to 64 characters', () =>
    Effect.gen(function* () {
      const writer = writerOver([adapterWithText('claude', 'haiku', answering('a'.repeat(100)))])

      const name = yield* writer.title('User: hello')

      assert.strictEqual(name.length, 64)
    })
  )
})

import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { type ModelCatalogState, ModelsLoading, ModelsReady, ModelsUnavailable } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { DateTime, Effect, Fiber, Option, Stream } from 'effect'
import { beforeEach, vi } from 'vitest'
import type { ClaudeInstall } from './claude-install'
import { makeClaudeCodeTextGeneration } from './text-generation'

const sdk = vi.hoisted(() => ({
  query: vi.fn<(params: { prompt: string; options: Record<string, unknown> }) => unknown>(),
  close: vi.fn()
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (params: { prompt: string; options: Record<string, unknown> }) => sdk.query(params)
}))

const running = (messages: ReadonlyArray<unknown>) =>
  Object.assign(
    (async function* () {
      yield* messages
    })(),
    { close: sdk.close }
  ) as unknown as Query

const hanging = () =>
  Object.assign(Stream.toAsyncIterable(Stream.never), { close: sdk.close }) as unknown as Query

const success = (result: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result
})

const install = (path: Option.Option<string>): ClaudeInstall => ({
  resolve: Effect.succeed(path),
  override: Effect.succeed(Option.none()),
  setOverride: () => Effect.void
})

const model = (value: string, effortLevels: ReadonlyArray<'low' | 'medium' | 'high'>) => ({
  value,
  displayName: value,
  description: '',
  adaptiveThinking: true,
  effortLevels,
  autoMode: false,
  fastMode: false
})

const ready = (...models: Array<ReturnType<typeof model>>): ModelCatalogState =>
  ModelsReady.make({
    models: models as [ReturnType<typeof model>, ...Array<ReturnType<typeof model>>],
    fetchedAt: DateTime.makeUnsafe(0),
    refreshing: false
  })

const generation = (
  state: ModelCatalogState,
  path: Option.Option<string> = Option.some('/bin/claude')
) =>
  makeClaudeCodeTextGeneration({
    install: install(path),
    dataDir: '/data',
    catalog: { models: () => Stream.make(state) }
  })

const request = {
  instructions: 'Title the thread.',
  input: 'Fix the login bug',
  model: 'haiku',
  effort: 'low'
} as const

const lastOptions = () => sdk.query.mock.calls.at(-1)?.[0].options

beforeEach(() => {
  sdk.query.mockReset()
  sdk.close.mockReset()
})

describe('makeClaudeCodeTextGeneration', () => {
  it('defaults to the haiku model', () => {
    assert.strictEqual(generation(ModelsLoading.make({})).defaultModel, 'haiku')
  })

  it.effect('returns the trimmed answer of one query that runs the request', () =>
    Effect.gen(function* () {
      sdk.query.mockReturnValue(running([success('  Fix login bug \n')]))

      const text = yield* generation(ready(model('haiku', ['low']))).generate(request)

      assert.strictEqual(text, 'Fix login bug')
      assert.strictEqual(sdk.query.mock.calls.length, 1)
      assert.strictEqual(sdk.query.mock.calls[0]?.[0].prompt, 'Fix the login bug')
      assert.strictEqual(lastOptions()?.systemPrompt, 'Title the thread.')
      assert.strictEqual(lastOptions()?.model, 'haiku')
      assert.strictEqual(lastOptions()?.cwd, '/data')
      assert.strictEqual(lastOptions()?.pathToClaudeCodeExecutable, '/bin/claude')
    })
  )

  it.effect('runs with no tools, no transcript, no MCP server, no settings and one turn', () =>
    Effect.gen(function* () {
      sdk.query.mockReturnValue(running([success('x')]))

      yield* generation(ready(model('haiku', ['low']))).generate(request)

      const options = lastOptions()
      assert.deepStrictEqual(options?.tools, [])
      assert.strictEqual(options?.persistSession, false)
      assert.strictEqual(options?.strictMcpConfig, true)
      assert.deepStrictEqual(options?.settingSources, [])
      assert.strictEqual(options?.maxTurns, 1)
    })
  )

  it.effect('closes the query once it has answered', () =>
    Effect.gen(function* () {
      sdk.query.mockReturnValue(running([success('x')]))

      yield* generation(ready(model('haiku', ['low']))).generate(request)

      assert.strictEqual(sdk.close.mock.calls.length, 1)
    })
  )

  it.effect('sends the effort when the ready catalog lists it for the model', () =>
    Effect.gen(function* () {
      sdk.query.mockReturnValue(running([success('x')]))

      yield* generation(ready(model('haiku', ['low', 'high']))).generate(request)

      assert.deepStrictEqual(lastOptions()?.thinking, { type: 'adaptive' })
      assert.strictEqual(lastOptions()?.effort, 'low')
    })
  )

  const withoutEffort: ReadonlyArray<readonly [string, ModelCatalogState]> = [
    ['the model lists no efforts', ready(model('haiku', []))],
    ['the model lists other efforts', ready(model('haiku', ['high']))],
    ['the model is not in the list', ready(model('sonnet', ['low']))],
    ['the list is loading', ModelsLoading.make({})],
    ['the list is unavailable', ModelsUnavailable.make({ message: 'offline', refreshing: false })]
  ]

  it.effect.each(withoutEffort)('disables thinking and sends no effort when %s', ([, state]) =>
    Effect.gen(function* () {
      sdk.query.mockReturnValue(running([success('x')]))

      yield* generation(state).generate(request)

      assert.deepStrictEqual(lastOptions()?.thinking, { type: 'disabled' })
      assert.isFalse('effort' in (lastOptions() ?? {}))
    })
  )

  it.effect('fails without starting a query when no install is found', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        generation(ready(model('haiku', ['low'])), Option.none()).generate(request)
      )

      assert.strictEqual(failure._tag, 'TextGenerationFailed')
      assert.strictEqual(sdk.query.mock.calls.length, 0)
    })
  )

  it.effect('fails when the result is an error', () =>
    Effect.gen(function* () {
      sdk.query.mockReturnValue(
        running([
          { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }
        ])
      )

      const failure = yield* Effect.flip(
        generation(ready(model('haiku', ['low']))).generate(request)
      )

      assert.strictEqual(failure._tag, 'TextGenerationFailed')
      assert.include(failure.reason, 'boom')
    })
  )

  it.effect('fails when the answer is blank', () =>
    Effect.gen(function* () {
      sdk.query.mockReturnValue(running([success('  \n ')]))

      const failure = yield* Effect.flip(
        generation(ready(model('haiku', ['low']))).generate(request)
      )

      assert.strictEqual(failure._tag, 'TextGenerationFailed')
    })
  )

  it.effect('fails when the query ends without a result', () =>
    Effect.gen(function* () {
      sdk.query.mockReturnValue(running([{ type: 'system' }]))

      const failure = yield* Effect.flip(
        generation(ready(model('haiku', ['low']))).generate(request)
      )

      assert.strictEqual(failure._tag, 'TextGenerationFailed')
      assert.strictEqual(sdk.close.mock.calls.length, 1)
    })
  )

  it.live('closes the query when the caller interrupts generate', () =>
    Effect.gen(function* () {
      sdk.query.mockReturnValue(hanging())
      const fiber = yield* Effect.forkChild(
        generation(ready(model('haiku', ['low']))).generate(request)
      )
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.strictEqual(sdk.query.mock.calls.length, 1))
      )

      yield* Fiber.interrupt(fiber)

      assert.strictEqual(sdk.close.mock.calls.length, 1)
    })
  )
})

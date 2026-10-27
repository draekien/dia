// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test yields to Node's event loop so the plugin's non-Effect callbacks run.
import { setImmediate } from 'node:timers/promises'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { type DiaTool, makePendingUserInput, type OutboundMessage } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { Allow, Deny } from '@shared/domain/attention'
import { Deferred, Effect, Fiber, Queue, Ref } from 'effect'
import { makeApproveDiaTool, makeCanUseTool, openPromptInput, type PromptInput } from './session'

const options = (toolUseID: string) =>
  ({ toolUseID, signal: new AbortController().signal, suggestions: undefined }) as never

const recordingEmit = Effect.gen(function* () {
  const emitted: Array<OutboundMessage> = []
  const first = yield* Deferred.make<OutboundMessage>()
  const emit = (message: OutboundMessage) =>
    Effect.suspend(() => {
      emitted.push(message)
      return Deferred.succeed(first, message)
    }).pipe(Effect.asVoid)
  return { emitted, first, emit }
})

const reloadTool: DiaTool = {
  name: 'plugin_reload',
  description: 'Reload a plugin.',
  input: { name: { description: 'Plugin name.', pattern: /^[a-z]+$/ } },
  run: () => Effect.succeed({ text: 'ok', isError: false })
}

describe('canUseTool', () => {
  it.effect('allows a dia tool without asking, because the tool asks the user itself', () =>
    Effect.gen(function* () {
      const { emitted, emit } = yield* recordingEmit
      const pending = makePendingUserInput()
      const canUseTool = makeCanUseTool([reloadTool], pending, emit, yield* Effect.context<never>())

      const result = yield* Effect.promise(() =>
        canUseTool('mcp__dia__plugin_reload', { name: 'x' }, options('t2'))
      )

      assert.deepStrictEqual(result, { behavior: 'allow' })
      assert.deepStrictEqual(emitted, [])
      assert.isFalse(yield* pending.isPending('t2'))
    })
  )

  it.effect('asks the user about a tool that is not a dia tool and returns their answer', () =>
    Effect.gen(function* () {
      const { first, emit } = yield* recordingEmit
      const pending = makePendingUserInput()
      const canUseTool = makeCanUseTool([reloadTool], pending, emit, yield* Effect.context<never>())

      const answer = yield* Effect.forkChild(
        Effect.promise(() => canUseTool('Bash', { command: 'ls' }, options('t3')))
      )
      const request = yield* Deferred.await(first)
      const matched = yield* pending.resolve('t3', Allow.make({}))
      const result = yield* Fiber.join(answer)

      assert.strictEqual(request._tag, 'PermissionRequested')
      assert.isTrue(matched)
      assert.strictEqual(result?.behavior, 'allow')
    })
  )

  it.effect('asks about a dia-shaped name that is not among the offered tools', () =>
    Effect.gen(function* () {
      const { first, emit } = yield* recordingEmit
      const canUseTool = makeCanUseTool(
        [],
        makePendingUserInput(),
        emit,
        yield* Effect.context<never>()
      )

      yield* Effect.forkChild(
        Effect.promise(() => canUseTool('mcp__dia__plugin_reload', { name: 'x' }, options('t4')))
      )
      const request = yield* Deferred.await(first)

      assert.strictEqual(request._tag, 'PermissionRequested')
    })
  )
})

describe('approveDiaTool', () => {
  it.effect('resolves true once the user allows the request', () =>
    Effect.gen(function* () {
      const { first, emit } = yield* recordingEmit
      const pending = makePendingUserInput()
      const approve = makeApproveDiaTool(pending, emit, yield* Ref.make(0))

      const approval = yield* Effect.forkChild(approve('mcp__dia__plugin_reload', { name: 'x' }))
      const request = yield* Deferred.await(first)
      assert.strictEqual(request._tag, 'PermissionRequested')
      yield* pending.resolve(
        request._tag === 'PermissionRequested' ? request.requestId : '',
        Allow.make({})
      )

      assert.isTrue(yield* Fiber.join(approval))
    })
  )

  it.effect('resolves false when the user denies the request', () =>
    Effect.gen(function* () {
      const { first, emit } = yield* recordingEmit
      const pending = makePendingUserInput()
      const approve = makeApproveDiaTool(pending, emit, yield* Ref.make(0))

      const approval = yield* Effect.forkChild(approve('mcp__dia__plugin_reload', { name: 'x' }))
      const request = yield* Deferred.await(first)
      yield* pending.resolve(
        request._tag === 'PermissionRequested' ? request.requestId : '',
        Deny.make({ message: 'no' })
      )

      assert.isFalse(yield* Fiber.join(approval))
    })
  )
})

const prompt = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null
})

const ended = { done: true, value: undefined } as const

const read = (input: PromptInput) => input.prompts[Symbol.asyncIterator]().next()

const settle = Effect.promise(() => setImmediate())

describe('openPromptInput', () => {
  it.effect('a prompt offered after a query input ends reaches the next query input', () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<SDKUserMessage>()
      const closedQuery = yield* openPromptInput(queue)
      const pendingRead = read(closedQuery)
      yield* settle
      yield* closedQuery.end
      const nextQuery = yield* openPromptInput(queue)
      const nextRead = read(nextQuery)
      yield* settle

      yield* Queue.offer(queue, prompt('turn 3'))

      assert.deepStrictEqual(yield* Effect.promise(() => pendingRead), ended)
      assert.deepStrictEqual(yield* Effect.promise(() => nextRead), {
        done: false,
        value: prompt('turn 3')
      })
    })
  )

  it.effect('a first read after end finishes as done and leaves the queued prompt', () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<SDKUserMessage>()
      const input = yield* openPromptInput(queue)
      yield* Queue.offer(queue, prompt('queued'))
      yield* input.end

      const result = yield* Effect.promise(() => read(input))

      assert.deepStrictEqual(result, ended)
      assert.strictEqual(yield* Queue.size(queue), 1)
    })
  )

  it.effect('every read after end finishes as done', () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<SDKUserMessage>()
      const input = yield* openPromptInput(queue)
      const iterator = input.prompts[Symbol.asyncIterator]()
      yield* input.end
      yield* input.end

      const first = yield* Effect.promise(() => iterator.next())
      const second = yield* Effect.promise(() => iterator.next())

      assert.deepStrictEqual([first, second], [ended, ended])
    })
  )

  it.effect('does not take a prompt offered between reads, so end leaves it queued', () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<SDKUserMessage>()
      const input = yield* openPromptInput(queue)
      const iterator = input.prompts[Symbol.asyncIterator]()
      yield* Queue.offer(queue, prompt('a'))
      const first = yield* Effect.promise(() => iterator.next())
      yield* Queue.offer(queue, prompt('b'))
      yield* settle

      yield* input.end

      assert.deepStrictEqual(first, { done: false, value: prompt('a') })
      assert.strictEqual(yield* Queue.size(queue), 1)
    })
  )
})

import { assert, describe, it } from '@effect/vitest'
import { Allow } from '@shared/domain/attention'
import { Deferred, Effect, Fiber, Option, Ref } from 'effect'
import { makePendingUserInput } from '../../../plugins/permissions/pending-user-input'
import { makeApprovePluginTool, makeCanUseTool } from './agent-session'
import { makeSessionPermissions, PENDING_USER_INPUT_KEY } from './permissions-seam'
import type { OutboundMessage } from './protocol'

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

const availablePending = Effect.gen(function* () {
  const permissions = yield* makeSessionPermissions({
    inject: (key) =>
      Effect.succeed(
        key === PENDING_USER_INPUT_KEY
          ? Option.some<unknown>(makePendingUserInput)
          : Option.some<unknown>(() => Effect.succeed({}))
      )
  })
  return permissions.pendingUserInput
})

describe('canUseTool', () => {
  it.effect('denies a tool call without a request when permissions are unavailable', () =>
    Effect.gen(function* () {
      const { emitted, emit } = yield* recordingEmit
      const pending = makePendingUserInput()
      const canUseTool = makeCanUseTool(pending, false, emit, yield* Effect.context<never>())

      const result = yield* Effect.promise(() =>
        canUseTool('Bash', { command: 'ls' }, options('t1'))
      )

      assert.deepStrictEqual(result, {
        behavior: 'deny',
        message: 'Permission handling is unavailable: the permissions plugin is not loaded.'
      })
      assert.deepStrictEqual(emitted, [])
      assert.isFalse(yield* pending.isPending('t1'))
    })
  )

  it.effect('still allows a plugin tool when permissions are unavailable', () =>
    Effect.gen(function* () {
      const { emitted, emit } = yield* recordingEmit
      const canUseTool = makeCanUseTool(
        makePendingUserInput(),
        false,
        emit,
        yield* Effect.context<never>()
      )

      const result = yield* Effect.promise(() =>
        canUseTool('mcp__dia__plugin_reload', { name: 'x' }, options('t2'))
      )

      assert.deepStrictEqual(result, { behavior: 'allow' })
      assert.deepStrictEqual(emitted, [])
    })
  )

  it.effect('asks the user and returns their answer when permissions are available', () =>
    Effect.gen(function* () {
      const { first, emit } = yield* recordingEmit
      const pending = yield* availablePending
      const canUseTool = makeCanUseTool(pending, true, emit, yield* Effect.context<never>())

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
})

describe('approvePluginTool', () => {
  it.effect('denies at once and emits nothing when permissions are unavailable', () =>
    Effect.gen(function* () {
      const { emitted, emit } = yield* recordingEmit
      const approve = makeApprovePluginTool(makePendingUserInput(), false, emit, yield* Ref.make(0))

      const approved = yield* approve('mcp__dia__plugin_reload', { name: 'x' })

      assert.isFalse(approved)
      assert.deepStrictEqual(emitted, [])
    })
  )

  it.effect('resolves true once the user allows the request', () =>
    Effect.gen(function* () {
      const { first, emit } = yield* recordingEmit
      const pending = yield* availablePending
      const approve = makeApprovePluginTool(pending, true, emit, yield* Ref.make(0))

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
})

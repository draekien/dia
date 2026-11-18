import { type AgentName, type CommittedEvent, TabNotFoundError } from '@dia/plugin'
import type { TextGenerationRequest } from '@dia-plugin/dia-agent-adapters/registry'
import { assert, describe, it } from '@effect/vitest'
import { MessageUpdated } from '@shared/domain/agent-event'
import { Effect, Queue, Stream } from 'effect'
import { type AutoTitleDeps, startAutoTitle } from './auto-title'
import {
  adapterWithText,
  answering,
  captureLogs,
  failing,
  messageOf,
  snapshotOf,
  workspaceWithTab
} from './text-generation.fake'
import { makeTitleWriter } from './writer'

const RUN = '11111111-1111-4111-8111-111111111111'
const OTHER_RUN = '22222222-2222-4222-8222-222222222222'
const SETTINGS = { adapter: 'claude', model: 'haiku', effort: 'low' } as const

const userMessage = (itemId: string, content: string): CommittedEvent => ({
  runId: RUN,
  sequence: 1,
  event: MessageUpdated.make({ itemId, message: { role: 'user', content }, streaming: false })
})

const assistantMessage = (itemId: string, content: string): CommittedEvent => ({
  runId: RUN,
  sequence: 2,
  event: MessageUpdated.make({ itemId, message: { role: 'assistant', content }, streaming: false })
})

interface Harness {
  readonly send: (event: CommittedEvent) => Effect.Effect<void>
  readonly renames: Array<{ readonly paneId: string; readonly name: AgentName }>
  readonly asked: Array<string>
}

const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

const started = (options: {
  readonly workspace: ReturnType<typeof workspaceWithTab>
  readonly answer: Parameters<typeof adapterWithText>[2]
  readonly messages?: Parameters<typeof snapshotOf>[0]
  readonly rename?: AutoTitleDeps['rename']
  readonly requests?: Array<TextGenerationRequest>
}) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<CommittedEvent>()
    const renames: Harness['renames'] = []
    const asked: Array<string> = []
    const writer = makeTitleWriter({
      settings: Effect.succeed(SETTINGS),
      adapters: Effect.succeed([
        adapterWithText('claude', 'haiku', options.answer, options.requests)
      ])
    })
    yield* startAutoTitle({
      events: Effect.succeed(Stream.fromQueue(queue)),
      snapshot: (runId) => {
        asked.push(runId)
        return Effect.succeed(
          snapshotOf(options.messages ?? [messageOf('u1', 'user', 'Fix the login bug')])
        )
      },
      workspace: Effect.succeed(options.workspace as never),
      writer,
      rename:
        options.rename ??
        ((paneId, name) =>
          Effect.sync(() => {
            renames.push({ paneId, name })
          }))
    })
    const send = (event: CommittedEvent) =>
      Queue.offer(queue, event).pipe(Effect.andThen(settle), Effect.asVoid)
    return { send, renames, asked } satisfies Harness
  })

describe('AutoTitle', () => {
  it.effect('renames a thread with a generated name after its first user message', () =>
    Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'brave-otter'),
        answer: answering('Fix the login bug')
      })

      yield* harness.send(userMessage('u1', 'Fix the login bug'))

      assert.deepStrictEqual(harness.renames, [{ paneId: RUN, name: 'Fix the login bug' }])
    }).pipe(Effect.scoped)
  )

  it.effect('titles from the conversation text, not the raw message', () =>
    Effect.gen(function* () {
      const requests: Array<TextGenerationRequest> = []
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'brave-otter'),
        answer: answering('T'),
        requests
      })

      yield* harness.send(userMessage('u1', 'Fix the login bug'))

      assert.deepStrictEqual(
        requests.map((request) => request.input),
        ['User: Fix the login bug']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('keeps a name the user typed', () =>
    Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'my own name'),
        answer: answering('Fix the login bug')
      })

      yield* harness.send(userMessage('u1', 'Fix the login bug'))

      assert.deepStrictEqual(harness.renames, [])
    }).pipe(Effect.scoped)
  )

  it.effect('keeps the name of a tab an org plugin owns', () =>
    Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'brave-otter', 'dia-org'),
        answer: answering('Fix the login bug')
      })

      yield* harness.send(userMessage('u1', 'Fix the login bug'))

      assert.deepStrictEqual(harness.renames, [])
    }).pipe(Effect.scoped)
  )

  it.effect('does not title a thread whose snapshot holds a second user message', () =>
    Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'brave-otter'),
        answer: answering('Fix the login bug'),
        messages: [
          messageOf('u1', 'user', 'first'),
          messageOf('a1', 'assistant', 'reply'),
          messageOf('u2', 'user', 'second')
        ]
      })

      yield* harness.send(userMessage('u2', 'second'))

      assert.deepStrictEqual(harness.renames, [])
    }).pipe(Effect.scoped)
  )

  it.effect('titles once when the same user message is committed twice', () =>
    Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'brave-otter'),
        answer: answering('Fix the login bug')
      })

      yield* harness.send(userMessage('u1', 'Fix'))
      yield* harness.send(userMessage('u1', 'Fix the login bug'))

      assert.strictEqual(harness.renames.length, 1)
      assert.strictEqual(harness.asked.length, 1)
    }).pipe(Effect.scoped)
  )

  it.effect('ignores assistant messages', () =>
    Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'brave-otter'),
        answer: answering('Fix the login bug')
      })

      yield* harness.send(assistantMessage('a1', 'hello'))

      assert.deepStrictEqual(harness.asked, [])
      assert.deepStrictEqual(harness.renames, [])
    }).pipe(Effect.scoped)
  )

  it.effect('skips a run that has no tab in the workspace', () =>
    Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(OTHER_RUN, 'brave-otter'),
        answer: answering('Fix the login bug')
      })

      yield* harness.send(userMessage('u1', 'Fix the login bug'))

      assert.deepStrictEqual(harness.renames, [])
    }).pipe(Effect.scoped)
  )

  it.effect('leaves the name and logs a warning when the title call fails', () => {
    const { logs, layer } = captureLogs()
    return Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'brave-otter'),
        answer: failing('Claude Code is not installed')
      })

      yield* harness.send(userMessage('u1', 'Fix the login bug'))

      assert.deepStrictEqual(harness.renames, [])
      assert.isTrue(logs.some((log) => log.level === 'Warn'))
    }).pipe(Effect.scoped, Effect.provide(layer))
  })

  it.effect('leaves the name when the answer holds no title', () =>
    Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'brave-otter'),
        answer: answering('   ')
      })

      yield* harness.send(userMessage('u1', 'Fix the login bug'))

      assert.deepStrictEqual(harness.renames, [])
    }).pipe(Effect.scoped)
  )

  it.effect('logs a warning when the tab is gone by the time the title is ready', () => {
    const { logs, layer } = captureLogs()
    return Effect.gen(function* () {
      const harness = yield* started({
        workspace: workspaceWithTab(RUN, 'brave-otter'),
        answer: answering('Fix the login bug'),
        rename: (paneId) => Effect.fail(new TabNotFoundError({ paneId }))
      })

      yield* harness.send(userMessage('u1', 'Fix the login bug'))

      assert.isTrue(logs.some((log) => log.level === 'Warn'))
    }).pipe(Effect.scoped, Effect.provide(layer))
  })

  it.effect('does not let a slow title block another run', () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CommittedEvent>()
      const renames: Array<string> = []
      const writer = makeTitleWriter({
        settings: Effect.succeed(SETTINGS),
        adapters: Effect.succeed([
          adapterWithText('claude', 'haiku', (request) =>
            request.input.includes('slow') ? Effect.never : Effect.succeed('Fast title')
          )
        ])
      })
      const two = workspaceWithTab(RUN, 'brave-otter')
      const second = workspaceWithTab(OTHER_RUN, 'calm-heron').projects[0]?.tabs[0]
      two.projects[0]?.tabs.push(second as never)
      yield* startAutoTitle({
        events: Effect.succeed(Stream.fromQueue(queue)),
        snapshot: (runId) =>
          Effect.succeed(
            snapshotOf([messageOf('u1', 'user', runId === RUN ? 'slow request' : 'quick request')])
          ),
        workspace: Effect.succeed(two as never),
        writer,
        rename: (paneId) => Effect.sync(() => void renames.push(paneId))
      })

      yield* Queue.offer(queue, userMessage('u1', 'slow request'))
      yield* Queue.offer(queue, { ...userMessage('u1', 'quick request'), runId: OTHER_RUN })
      yield* settle

      assert.deepStrictEqual(renames, [OTHER_RUN])
    }).pipe(Effect.scoped)
  )
})

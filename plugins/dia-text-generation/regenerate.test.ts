import { type AgentName, TabNotFoundError } from '@dia/plugin'
import type { TextGenerationRequest } from '@dia-plugin/dia-agent-adapters/registry'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { conversationText } from './conversation'
import { regenerateTitle } from './regenerate'
import { adapterWithText, answering, failing, messageOf, snapshotOf } from './text-generation.fake'
import { makeTitleWriter } from './writer'

const SETTINGS = { adapter: 'claude', model: 'haiku', effort: 'low' } as const

const regenerating = (options: {
  readonly messages: Parameters<typeof snapshotOf>[0]
  readonly answer?: Parameters<typeof adapterWithText>[2]
  readonly missingTab?: boolean
}) => {
  const requests: Array<TextGenerationRequest> = []
  const renames: Array<{ readonly paneId: string; readonly name: AgentName }> = []
  const run = (paneId: string) =>
    regenerateTitle(
      {
        snapshot: () => Effect.succeed(snapshotOf(options.messages)),
        writer: makeTitleWriter({
          settings: Effect.succeed(SETTINGS),
          adapters: Effect.succeed([
            adapterWithText('claude', 'haiku', options.answer ?? answering('New title'), requests)
          ])
        }),
        rename: (id, name) =>
          options.missingTab === true
            ? Effect.fail(new TabNotFoundError({ paneId: id }))
            : Effect.sync(() => {
                renames.push({ paneId: id, name })
              })
      },
      paneId
    )
  return { run, requests, renames }
}

describe('regenerateTitle', () => {
  it.effect('renames the thread from a conversation holding the user and assistant text', () =>
    Effect.gen(function* () {
      const { run, requests, renames } = regenerating({
        messages: [
          messageOf('u1', 'user', 'How do I rebase?'),
          messageOf('a1', 'assistant', 'Use git rebase -i.')
        ]
      })

      yield* run('pane-1')

      assert.deepStrictEqual(renames, [{ paneId: 'pane-1', name: 'New title' }])
      assert.strictEqual(
        requests[0]?.input,
        'User: How do I rebase?\nAssistant: Use git rebase -i.'
      )
    })
  )

  it.effect('fails with TitleNotGenerated and renames nothing when the call fails', () =>
    Effect.gen(function* () {
      const { run, renames } = regenerating({
        messages: [messageOf('u1', 'user', 'hi')],
        answer: failing('Claude Code is not installed')
      })

      const error = yield* Effect.flip(run('pane-1'))

      assert.strictEqual(error._tag, 'TitleNotGenerated')
      assert.deepStrictEqual(renames, [])
    })
  )

  it.effect('fails with TitleNotGenerated when the thread has no conversation text', () =>
    Effect.gen(function* () {
      const { run, requests } = regenerating({ messages: [] })

      const error = yield* Effect.flip(run('pane-1'))

      assert.strictEqual(error._tag, 'TitleNotGenerated')
      assert.deepStrictEqual(requests, [])
    })
  )

  it.effect('fails with TitleNotGenerated when no tab has the id', () =>
    Effect.gen(function* () {
      const { run } = regenerating({
        messages: [messageOf('u1', 'user', 'hi')],
        missingTab: true
      })

      const error = yield* Effect.flip(run('pane-9'))

      assert.strictEqual(error._tag, 'TitleNotGenerated')
    })
  )
})

describe('conversationText', () => {
  it('joins the text of each message in order, one labelled line per message', () => {
    assert.strictEqual(
      conversationText([messageOf('u1', 'user', 'a'), messageOf('a1', 'assistant', 'b')]),
      'User: a\nAssistant: b'
    )
  })

  it('leaves out tool calls, thinking, notices and errors', () => {
    const text = conversationText([
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'thinking', content: 'secret thoughts' },
          { type: 'text', content: 'visible' },
          { type: 'tool-call', toolCallId: 't', name: 'Bash', state: 'done' }
        ]
      },
      { id: 'n1', role: 'notice', parts: [{ type: 'text', content: 'compacted' }] },
      { id: 'e1', role: 'error', parts: [{ type: 'text', content: 'boom' }] }
    ])

    assert.strictEqual(text, 'Assistant: visible')
  })

  it('is empty for no messages', () => {
    assert.strictEqual(conversationText([]), '')
  })

  it('keeps the last 8000 characters when the conversation is longer', () => {
    const text = conversationText([
      messageOf('u1', 'user', 'x'.repeat(9000)),
      messageOf('a1', 'assistant', 'END')
    ])

    assert.strictEqual(text.length, 8000)
    assert.isTrue(text.endsWith('\nAssistant: END'))
  })
})

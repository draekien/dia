import { assert, describe, it } from '@effect/vitest'
import { type PaneConfig, SessionId } from '@shared/domain/pane'
import { Effect, Option } from 'effect'
import {
  AGENT_BACKEND_KEY,
  type AgentBackend,
  adapterContract,
  agentBackendProblems,
  resolveAgentBackend
} from './agent-backend'

const registryProviding = (value: Option.Option<unknown>) => ({
  inject: (key: string) => Effect.succeed(key === AGENT_BACKEND_KEY ? value : Option.none())
})

const config: PaneConfig = {
  paneId: '00000000-0000-0000-0000-000000000001',
  cwd: '/work',
  model: 'claude-sonnet-5',
  thinkingLevel: 'off',
  permissionMode: 'default'
}

const openOptions = {
  config,
  resume: Option.none(),
  emit: () => Effect.void,
  tools: []
}

describe('resolveAgentBackend', () => {
  it.effect('returns the backend the adapter provides', () =>
    Effect.gen(function* () {
      const backend: AgentBackend = {
        openSession: () => Effect.die('not called'),
        readHistory: () => Effect.succeed([{ role: 'user', content: 'hi' }])
      }

      const resolved = yield* resolveAgentBackend(registryProviding(Option.some(backend)))

      assert.strictEqual(resolved, backend)
    })
  )

  const invalidCases: ReadonlyArray<readonly [string, Option.Option<unknown>]> = [
    ['no plugin provides one', Option.none()],
    ['the value is not an object', Option.some('backend')],
    ['the value lacks openSession', Option.some({ readHistory: () => Effect.succeed([]) })],
    [
      'readHistory is not a function',
      Option.some({ openSession: () => Effect.void, readHistory: 1 })
    ]
  ]

  for (const [name, provided] of invalidCases) {
    it.effect(`returns a backend whose sessions end at once when ${name}`, () =>
      Effect.gen(function* () {
        const backend = yield* resolveAgentBackend(registryProviding(provided))

        const session = yield* backend.openSession(openOptions).pipe(Effect.scoped)
        const reason = yield* session.ended

        assert.strictEqual(reason, 'The claude-code adapter is not loaded')
      })
    )

    it.effect(`returns a backend that reads an empty history when ${name}`, () =>
      Effect.gen(function* () {
        const backend = yield* resolveAgentBackend(registryProviding(provided))

        const history = yield* backend.readHistory(SessionId.make('s-1'), '/work')

        assert.deepStrictEqual(history, [])
      })
    )
  }
})

describe('agentBackendProblems', () => {
  const validBackend = { openSession: () => Effect.void, readHistory: () => Effect.succeed([]) }

  it('reports no problem for a value with both backend methods', () => {
    assert.deepStrictEqual(agentBackendProblems(Option.some(validBackend)), [])
  })

  const problemCases: ReadonlyArray<
    readonly [string, Option.Option<unknown>, ReadonlyArray<string>]
  > = [
    ['nothing was provided', Option.none(), ['setup did not provide "agentBackend"']],
    [
      'openSession is missing',
      Option.some({ readHistory: validBackend.readHistory }),
      ['"agentBackend.openSession" is not a function']
    ],
    [
      'readHistory is not a function',
      Option.some({ openSession: validBackend.openSession, readHistory: 'history' }),
      ['"agentBackend.readHistory" is not a function']
    ],
    [
      'the value is not an object',
      Option.some(42),
      [
        '"agentBackend.openSession" is not a function',
        '"agentBackend.readHistory" is not a function'
      ]
    ]
  ]

  for (const [name, provided, expected] of problemCases) {
    it(`reports each missing method when ${name}`, () => {
      assert.deepStrictEqual(agentBackendProblems(provided), expected)
    })
  }
})

describe('adapterContract', () => {
  it('reserves agentBackend for adapter plugins', () => {
    assert.deepStrictEqual(adapterContract.keys, ['agentBackend'])
  })

  it('checks the value the adapter provided under agentBackend', () => {
    const provided = (key: string) =>
      key === AGENT_BACKEND_KEY ? Option.some({ openSession: () => Effect.void }) : Option.none()

    assert.deepStrictEqual(adapterContract.problems(provided), [
      '"agentBackend.readHistory" is not a function'
    ])
  })
})

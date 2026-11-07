import { assert, describe, it } from '@effect/vitest'
import { type PaneConfig, SessionId } from '@shared/domain/pane'
import { fakeInject } from '@shared/plugin/plugin-registry.fake'
import { Effect, Option, Stream } from 'effect'
import {
  type AgentBackend,
  AgentBackendKey,
  adapterContract,
  agentBackendProblems,
  resolveAgentBackend,
  SessionFailed
} from './agent-backend'

const registryProviding = (value: Option.Option<unknown>) => ({
  inject: fakeInject((key) => (key === AgentBackendKey.name ? value : Option.none()))
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
  diaTools: [],
  systemPromptAppend: '',
  pluginPaths: [],
  tools: Option.none()
}

describe('resolveAgentBackend', () => {
  it.effect('returns the backend the adapter provides', () =>
    Effect.gen(function* () {
      const backend: AgentBackend = {
        openSession: () => Effect.die('not called'),
        readHistory: () => Effect.succeed([{ role: 'user', content: 'hi' }]),
        transcriptInfo: () => Effect.succeed(Option.none()),
        readTranscriptAfter: () => Effect.succeed(Option.none()),
        models: () => Stream.empty,
        refreshModels: () => Effect.void,
        status: () => Stream.empty,
        checkHealth: () => Effect.void,
        setInstallPath: () => Effect.void,
        disabledPermissionModes: () => Effect.succeed([]),
        attachmentTypes: () => Effect.succeed([])
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
        const end = yield* session.ended

        assert.deepStrictEqual(
          end,
          SessionFailed.make({ reason: 'The claude-code adapter is not loaded' })
        )
      })
    )

    it.effect(`returns a backend that reads an empty history when ${name}`, () =>
      Effect.gen(function* () {
        const backend = yield* resolveAgentBackend(registryProviding(provided))

        const history = yield* backend.readHistory(SessionId.make('s-1'), '/work')

        assert.deepStrictEqual(history, [])
      })
    )

    it.effect(`returns a backend that reads no transcript info when ${name}`, () =>
      Effect.gen(function* () {
        const backend = yield* resolveAgentBackend(registryProviding(provided))

        const info = yield* backend.transcriptInfo(SessionId.make('s-1'), '/work')

        assert.deepStrictEqual(info, Option.none())
      })
    )

    it.effect(`returns a backend whose model list is unavailable when ${name}`, () =>
      Effect.gen(function* () {
        const backend = yield* resolveAgentBackend(registryProviding(provided))

        const states = yield* Stream.runCollect(backend.models())

        assert.deepStrictEqual(states, [
          {
            _tag: 'Unavailable',
            message: 'The claude-code adapter is not loaded',
            refreshing: false
          }
        ])
      })
    )
  }
})

describe('agentBackendProblems', () => {
  const validBackend = {
    openSession: () => Effect.void,
    readHistory: () => Effect.succeed([]),
    transcriptInfo: () => Effect.succeed(Option.none()),
    readTranscriptAfter: () => Effect.succeed(Option.none()),
    models: () => Stream.empty,
    refreshModels: () => Effect.void,
    status: () => Stream.empty,
    checkHealth: () => Effect.void,
    setInstallPath: () => Effect.void,
    disabledPermissionModes: () => Effect.succeed([]),
    attachmentTypes: () => Effect.succeed([])
  }

  it('reports no problem for a value with every backend method', () => {
    assert.deepStrictEqual(agentBackendProblems(Option.some(validBackend)), [])
  })

  it('reports no problem for a backend that can discover sessions', () => {
    const discovering = { ...validBackend, discoverSessions: () => Effect.succeed([]) }

    assert.deepStrictEqual(agentBackendProblems(Option.some(discovering)), [])
  })

  it('reports no problem for a backend whose discoverSessions is undefined', () => {
    const undiscovering = { ...validBackend, discoverSessions: undefined }

    assert.deepStrictEqual(agentBackendProblems(Option.some(undiscovering)), [])
  })

  it('reports a discoverSessions that is not a function', () => {
    const broken = { ...validBackend, discoverSessions: 'sessions' }

    assert.deepStrictEqual(agentBackendProblems(Option.some(broken)), [
      '"agentBackend.discoverSessions" is not a function'
    ])
  })

  const problemCases: ReadonlyArray<
    readonly [string, Option.Option<unknown>, ReadonlyArray<string>]
  > = [
    ['nothing was provided', Option.none(), ['setup did not provide "agentBackend"']],
    [
      'openSession is missing',
      Option.some({ ...validBackend, openSession: undefined }),
      ['"agentBackend.openSession" is not a function']
    ],
    [
      'readHistory is not a function',
      Option.some({ ...validBackend, readHistory: 'history' }),
      ['"agentBackend.readHistory" is not a function']
    ],
    [
      'the value is not an object',
      Option.some(42),
      [
        '"agentBackend.openSession" is not a function',
        '"agentBackend.readHistory" is not a function',
        '"agentBackend.transcriptInfo" is not a function',
        '"agentBackend.readTranscriptAfter" is not a function',
        '"agentBackend.models" is not a function',
        '"agentBackend.refreshModels" is not a function',
        '"agentBackend.status" is not a function',
        '"agentBackend.checkHealth" is not a function',
        '"agentBackend.setInstallPath" is not a function',
        '"agentBackend.disabledPermissionModes" is not a function',
        '"agentBackend.attachmentTypes" is not a function'
      ]
    ],
    [
      'transcriptInfo is missing',
      Option.some({ ...validBackend, transcriptInfo: undefined }),
      ['"agentBackend.transcriptInfo" is not a function']
    ],
    [
      'readTranscriptAfter is missing',
      Option.some({ ...validBackend, readTranscriptAfter: undefined }),
      ['"agentBackend.readTranscriptAfter" is not a function']
    ],
    [
      'models is missing',
      Option.some({ ...validBackend, models: undefined }),
      ['"agentBackend.models" is not a function']
    ],
    [
      'refreshModels is an effect rather than a function',
      Option.some({ ...validBackend, refreshModels: Effect.void }),
      ['"agentBackend.refreshModels" is not a function']
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
      key === AgentBackendKey.name ? Option.some({ openSession: () => Effect.void }) : Option.none()

    assert.deepStrictEqual(adapterContract.problems(provided), [
      '"agentBackend.readHistory" is not a function',
      '"agentBackend.transcriptInfo" is not a function',
      '"agentBackend.readTranscriptAfter" is not a function',
      '"agentBackend.models" is not a function',
      '"agentBackend.refreshModels" is not a function',
      '"agentBackend.status" is not a function',
      '"agentBackend.checkHealth" is not a function',
      '"agentBackend.setInstallPath" is not a function',
      '"agentBackend.disabledPermissionModes" is not a function',
      '"agentBackend.attachmentTypes" is not a function'
    ])
  })
})

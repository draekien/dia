import { assert, describe, it } from '@effect/vitest'
import { type PaneConfig, SessionId } from '@shared/domain/pane'
import { Effect, Option, Stream } from 'effect'
import { agentBackendProblems, SessionFailed, unavailableBackend } from './backend'

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

describe('unavailableBackend', () => {
  it.effect('ends every session at once saying the adapter is not loaded', () =>
    Effect.gen(function* () {
      const session = yield* unavailableBackend.openSession(openOptions).pipe(Effect.scoped)

      assert.deepStrictEqual(
        yield* session.ended,
        SessionFailed.make({ reason: 'The claude-code adapter is not loaded' })
      )
    })
  )

  it.effect('reads an empty history', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* unavailableBackend.readHistory(SessionId.make('s-1'), '/work'),
        []
      )
    })
  )

  it.effect('reads no transcript info', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* unavailableBackend.transcriptInfo(SessionId.make('s-1'), '/work'),
        Option.none()
      )
    })
  )

  it.effect('reports the model list as unavailable', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* Stream.runCollect(unavailableBackend.models()), [
        {
          _tag: 'Unavailable',
          message: 'The claude-code adapter is not loaded',
          refreshing: false
        }
      ])
    })
  )
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

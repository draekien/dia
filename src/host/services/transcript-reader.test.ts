import { assert, describe, it } from '@effect/vitest'
import { type ConversationMessage, SessionId } from '@shared/domain/pane'
import { Effect, Layer, Option, Stream } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import {
  AGENT_BACKEND_KEY,
  type AgentBackend,
  type DiscoveredSession
} from '../session/agent-backend'
import { TranscriptReader, TranscriptReaderLive } from './transcript-reader'

const pluginsProviding = (backend: Option.Option<AgentBackend>) =>
  Layer.succeed(HostPlugins)({
    list: () => Effect.succeed([]),
    start: () => Effect.void,
    changes: Stream.empty,
    load: () => Effect.die(new Error('load should not be called in these tests')),
    unload: () => Effect.die(new Error('unload should not be called in these tests')),
    inject: (key) => Effect.succeed(key === AGENT_BACKEND_KEY ? backend : Option.none())
  })

const backendWithout: AgentBackend = {
  openSession: () => Effect.die('not called'),
  readHistory: () => Effect.die('not called'),
  readTranscriptAfter: () => Effect.die('not called'),
  models: () => Stream.empty,
  refreshModels: () => Effect.die('not called'),
  status: () => Stream.empty,
  checkHealth: () => Effect.void,
  setInstallPath: () => Effect.void,
  disabledPermissionModes: () => Effect.succeed([]),
  attachmentTypes: () => Effect.succeed([])
}

const readerWith = (backend: Option.Option<AgentBackend>) =>
  Layer.provide(TranscriptReaderLive, pluginsProviding(backend))

describe('TranscriptReaderLive', () => {
  it.effect('reads the history through the loaded agent backend', () =>
    Effect.gen(function* () {
      const reads: Array<string> = []
      const history: ReadonlyArray<ConversationMessage> = [{ role: 'user', content: 'hello' }]
      const backend: AgentBackend = {
        openSession: () => Effect.die('not called'),
        readHistory: (sessionId, cwd) =>
          Effect.sync(() => {
            reads.push(`${sessionId}@${cwd}`)
            return history
          }),
        readTranscriptAfter: () => Effect.die('not called'),
        models: () => Stream.empty,
        refreshModels: () => Effect.die('not called'),
        status: () => Stream.empty,
        checkHealth: () => Effect.void,
        setInstallPath: () => Effect.void,
        disabledPermissionModes: () => Effect.succeed([]),
        attachmentTypes: () => Effect.succeed([])
      }

      const read = yield* Effect.gen(function* () {
        const reader = yield* TranscriptReader
        return yield* reader.readHistory(SessionId.make('s-1'), '/work')
      }).pipe(Effect.provide(readerWith(Option.some(backend))))

      assert.deepStrictEqual(read, history)
      assert.deepStrictEqual(reads, ['s-1@/work'])
    })
  )

  it.effect('returns an empty history when no agent backend is loaded', () =>
    Effect.gen(function* () {
      const read = yield* Effect.gen(function* () {
        const reader = yield* TranscriptReader
        return yield* reader.readHistory(SessionId.make('s-1'), '/work')
      }).pipe(Effect.provide(readerWith(Option.none())))

      assert.deepStrictEqual(read, [])
    })
  )

  const discoverIn = (directory: string) =>
    Effect.flatMap(TranscriptReader, (reader) => reader.discoverSessions(directory))

  it.effect('discovers sessions through the loaded agent backend', () =>
    Effect.gen(function* () {
      const session: DiscoveredSession = {
        sessionId: SessionId.make('s-1'),
        title: 'Chat',
        startedAt: 1,
        model: 'default'
      }
      const asked: Array<string> = []
      const backend: AgentBackend = {
        ...backendWithout,
        discoverSessions: (directory) =>
          Effect.sync(() => {
            asked.push(directory)
            return [session]
          })
      }

      const found = yield* discoverIn('/work').pipe(
        Effect.provide(readerWith(Option.some(backend)))
      )

      assert.deepStrictEqual(found, [session])
      assert.deepStrictEqual(asked, ['/work'])
    })
  )

  it.effect('discovers nothing through a backend that cannot discover sessions', () =>
    Effect.gen(function* () {
      const found = yield* discoverIn('/work').pipe(
        Effect.provide(readerWith(Option.some(backendWithout)))
      )

      assert.deepStrictEqual(found, [])
    })
  )

  it.effect('discovers nothing when no agent backend is loaded', () =>
    Effect.gen(function* () {
      const found = yield* discoverIn('/work').pipe(Effect.provide(readerWith(Option.none())))

      assert.deepStrictEqual(found, [])
    })
  )
})

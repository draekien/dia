import { FileSystem } from '@effect/platform'
import { SystemError } from '@effect/platform/Error'
import { assert, describe, it } from '@effect/vitest'
import type { PaneNode } from '@shared/domain/pane-tree'
import { Effect, Layer, Logger, Option } from 'effect'
import {
  makePersistenceServiceLive,
  type PersistedWorkspace,
  PersistenceService,
  PersistenceWriteError
} from './persistence'

const USER_DATA = '/userData'
const FILE = `${USER_DATA}/workspace.json`
const TEMP = `${FILE}.tmp`

const PANE_A = '11111111-1111-4111-8111-111111111111'
const PANE_B = '22222222-2222-4222-8222-222222222222'

const tree: PaneNode = {
  _tag: 'Split',
  direction: 'row',
  children: [
    { _tag: 'Leaf', paneId: PANE_A, status: 'ready', cwd: '/repo/a' },
    { _tag: 'Leaf', paneId: PANE_B, status: 'ready', cwd: '/wt/b', sourceRepo: '/repo' }
  ],
  sizes: [0.5, 0.5]
}

const workspace: PersistedWorkspace = {
  tree,
  panes: {
    [PANE_A]: { config: { paneId: PANE_A, cwd: '/repo/a', model: 'claude-sonnet-5' } },
    [PANE_B]: {
      config: {
        paneId: PANE_B,
        cwd: '/wt/b',
        model: 'claude-opus-4-8',
        worktree: { path: '/wt/b', branch: 'dia/pane-b', sourceRepo: '/repo' }
      },
      sessionId: 'session-b-123'
    }
  }
}

function missingFile(path: string): SystemError {
  return new SystemError({
    reason: 'NotFound',
    module: 'FileSystem',
    method: 'readFileString',
    pathOrDescriptor: path
  })
}

function makeInMemoryFs(overrides: Partial<FileSystem.FileSystem> = {}): {
  readonly files: Map<string, string>
  readonly ops: Array<string>
  readonly fsLayer: Layer.Layer<FileSystem.FileSystem>
} {
  const files = new Map<string, string>()
  const ops: Array<string> = []

  const fs = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(String(path))),
    readFileString: (path) => {
      const content = files.get(String(path))
      return content === undefined
        ? Effect.fail(missingFile(String(path)))
        : Effect.succeed(content)
    },
    writeFileString: (path, data) =>
      Effect.sync(() => {
        files.set(String(path), String(data))
        ops.push(`write:${String(path)}`)
      }),
    rename: (oldPath, newPath) =>
      Effect.sync(() => {
        const content = files.get(oldPath)
        if (content !== undefined) files.set(newPath, content)
        files.delete(oldPath)
        ops.push(`rename:${oldPath}->${newPath}`)
      }),
    ...overrides
  })

  return { files, ops, fsLayer: Layer.succeed(FileSystem.FileSystem, fs) }
}

function makeLogCapture(): {
  readonly logs: Array<unknown>
  readonly loggerLayer: Layer.Layer<never>
} {
  const logs: unknown[] = []
  const logger = Logger.make(({ message }) => {
    logs.push(...(Array.isArray(message) ? message : [message]))
  })
  return { logs, loggerLayer: Logger.add(logger) }
}

describe('PersistenceService', () => {
  it.effect('round-trips a workspace through save then load without loss', () =>
    Effect.gen(function* () {
      const { fsLayer } = makeInMemoryFs()
      const { loggerLayer } = makeLogCapture()

      const loaded = yield* Effect.gen(function* () {
        const service = yield* PersistenceService
        yield* service.saveWorkspace(workspace)
        return yield* service.loadWorkspace()
      }).pipe(
        Effect.provide(makePersistenceServiceLive(USER_DATA)),
        Effect.provide(fsLayer),
        Effect.provide(loggerLayer)
      )

      assert.deepStrictEqual(loaded, Option.some(workspace))
    })
  )

  it.effect('writes to a temp file then renames it onto the final path (atomic write)', () =>
    Effect.gen(function* () {
      const { files, ops, fsLayer } = makeInMemoryFs()

      yield* Effect.gen(function* () {
        const service = yield* PersistenceService
        yield* service.saveWorkspace(workspace)
      }).pipe(Effect.provide(makePersistenceServiceLive(USER_DATA)), Effect.provide(fsLayer))

      assert.deepStrictEqual(ops, [`write:${TEMP}`, `rename:${TEMP}->${FILE}`])
      assert.isTrue(files.has(FILE))
      assert.isFalse(files.has(TEMP))
    })
  )

  it.effect('load returns None when no workspace file exists yet', () =>
    Effect.gen(function* () {
      const { fsLayer } = makeInMemoryFs()

      const loaded = yield* Effect.gen(function* () {
        const service = yield* PersistenceService
        return yield* service.loadWorkspace()
      }).pipe(Effect.provide(makePersistenceServiceLive(USER_DATA)), Effect.provide(fsLayer))

      assert.isTrue(Option.isNone(loaded))
    })
  )

  it.effect('load returns None and warns when the file is not valid JSON', () =>
    Effect.gen(function* () {
      const { files, fsLayer } = makeInMemoryFs()
      files.set(FILE, 'not json at all')
      const { logs, loggerLayer } = makeLogCapture()

      const loaded = yield* Effect.gen(function* () {
        const service = yield* PersistenceService
        return yield* service.loadWorkspace()
      }).pipe(
        Effect.provide(makePersistenceServiceLive(USER_DATA)),
        Effect.provide(fsLayer),
        Effect.provide(loggerLayer)
      )

      assert.isTrue(Option.isNone(loaded))
      assert.isTrue(logs.some((log) => String(log).includes('Workspace file is malformed')))
    })
  )

  it.effect('load returns None and warns when JSON does not match the schema', () =>
    Effect.gen(function* () {
      const { files, fsLayer } = makeInMemoryFs()
      files.set(FILE, JSON.stringify({ tree: { _tag: 'Nonsense' }, panes: {} }))
      const { logs, loggerLayer } = makeLogCapture()

      const loaded = yield* Effect.gen(function* () {
        const service = yield* PersistenceService
        return yield* service.loadWorkspace()
      }).pipe(
        Effect.provide(makePersistenceServiceLive(USER_DATA)),
        Effect.provide(fsLayer),
        Effect.provide(loggerLayer)
      )

      assert.isTrue(Option.isNone(loaded))
      assert.isTrue(logs.some((log) => String(log).includes('Workspace file is malformed')))
    })
  )

  it.effect('load returns None and warns when the existing file cannot be read', () =>
    Effect.gen(function* () {
      const { fsLayer } = makeInMemoryFs({
        exists: () => Effect.succeed(true),
        readFileString: (path) => Effect.fail(missingFile(String(path)))
      })
      const { logs, loggerLayer } = makeLogCapture()

      const loaded = yield* Effect.gen(function* () {
        const service = yield* PersistenceService
        return yield* service.loadWorkspace()
      }).pipe(
        Effect.provide(makePersistenceServiceLive(USER_DATA)),
        Effect.provide(fsLayer),
        Effect.provide(loggerLayer)
      )

      assert.isTrue(Option.isNone(loaded))
      assert.isTrue(logs.some((log) => String(log).includes('Failed to read workspace file')))
    })
  )

  it.effect('save fails with PersistenceWriteError when the underlying write fails', () =>
    Effect.gen(function* () {
      const { fsLayer } = makeInMemoryFs({
        writeFileString: (path) =>
          Effect.fail(
            new SystemError({
              reason: 'PermissionDenied',
              module: 'FileSystem',
              method: 'writeFileString',
              pathOrDescriptor: String(path)
            })
          )
      })

      const result = yield* Effect.gen(function* () {
        const service = yield* PersistenceService
        return yield* service.saveWorkspace(workspace)
      }).pipe(
        Effect.provide(makePersistenceServiceLive(USER_DATA)),
        Effect.provide(fsLayer),
        Effect.flip
      )

      assert.instanceOf(result, PersistenceWriteError)
      assert.strictEqual(result.path, TEMP)
    })
  )
})

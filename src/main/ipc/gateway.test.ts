import { assert, beforeEach, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { ipcMain } from 'electron'
import { vi } from 'vitest'
import type { PaneNode } from '../domain/pane-tree'
import { WorktreeCreateError } from '../services/git-ops-service'
import type { PaneHandle } from '../services/pane-supervisor'
import { CHANNEL } from './contract'
import type { EventSender } from './gateway'
import { wireCommands } from './gateway'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), off: vi.fn() },
  dialog: {}
}))

const PANE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const READY_TREE: PaneNode = { _tag: 'Leaf', paneId: PANE_ID, status: 'ready', cwd: '/repo' }

// Mirrors the `flush` helper in pane-supervisor.test.ts -- runs the fiber scheduler forward
// without touching the Clock, giving the forked wireCommands loop a chance to react to the
// listener being invoked below.
const flush = Effect.repeatN(Effect.yieldNow(), 50)

beforeEach(() => {
  vi.mocked(ipcMain.on).mockClear()
})

function emitCommand(command: unknown): void {
  const call = vi.mocked(ipcMain.on).mock.calls.at(-1)
  if (call === undefined) throw new Error('wireCommands did not register an ipcMain listener')
  const listener = call[1] as (event: unknown, raw: unknown) => void
  listener(undefined, command)
}

describe('wireCommands', () => {
  it.effect('drops a malformed command and logs a warning instead of throwing', () =>
    Effect.gen(function* () {
      const sent: Array<[string, unknown]> = []
      const webContents: EventSender = { send: (channel, payload) => sent.push([channel, payload]) }
      const paneWorkspace = {
        getTree: () => Effect.succeed(READY_TREE),
        split: () => Effect.dieMessage('split should not be called'),
        createPane: () => Effect.dieMessage('createPane should not be called'),
        close: () => Effect.dieMessage('close should not be called'),
        getPaneHistory: () => Effect.dieMessage('getPaneHistory should not be called')
      }
      const paneSupervisor = {
        openPane: () => Effect.dieMessage('openPane should not be called'),
        closePane: () => Effect.dieMessage('closePane should not be called'),
        getHandle: () => Effect.dieMessage('getHandle should not be called'),
        closeAll: () => Effect.dieMessage('closeAll should not be called')
      }

      yield* Effect.gen(function* () {
        yield* Effect.fork(wireCommands({ paneWorkspace, paneSupervisor, webContents }))
        yield* flush

        emitCommand({ _tag: 'SendMessage', paneId: 'not-a-uuid', text: 'hi' })
        yield* flush

        assert.deepStrictEqual(sent, [])
      }).pipe(Effect.scoped)
    })
  )

  it.effect('sends a LayoutChanged event after a successful SplitPane', () =>
    Effect.gen(function* () {
      const sent: Array<[string, unknown]> = []
      const webContents: EventSender = { send: (channel, payload) => sent.push([channel, payload]) }
      const splitTree: PaneNode = {
        _tag: 'Split',
        direction: 'row',
        children: [
          READY_TREE,
          { _tag: 'Leaf', paneId: 'bbbbbbbb-0000-4000-8000-000000000002', status: 'pending' }
        ],
        sizes: [0.5, 0.5]
      }
      const paneWorkspace = {
        getTree: () => Effect.dieMessage('getTree should not be called'),
        split: () => Effect.succeed(splitTree),
        createPane: () => Effect.dieMessage('createPane should not be called'),
        close: () => Effect.dieMessage('close should not be called'),
        getPaneHistory: () => Effect.dieMessage('getPaneHistory should not be called')
      }
      const paneSupervisor = {
        openPane: () => Effect.dieMessage('openPane should not be called'),
        closePane: () => Effect.dieMessage('closePane should not be called'),
        getHandle: () => Effect.dieMessage('getHandle should not be called'),
        closeAll: () => Effect.dieMessage('closeAll should not be called')
      }

      yield* Effect.gen(function* () {
        yield* Effect.fork(wireCommands({ paneWorkspace, paneSupervisor, webContents }))
        yield* flush

        emitCommand({ _tag: 'SplitPane', paneId: PANE_ID, direction: 'row' })
        yield* flush

        assert.strictEqual(sent.length, 1)
        const [channel, payload] = sent[0]
        assert.strictEqual(channel, CHANNEL.event)
        assert.deepStrictEqual(payload, { _tag: 'LayoutChanged', tree: splitTree })
      }).pipe(Effect.scoped)
    })
  )

  it.effect('emits PaneCreateFailed instead of LayoutChanged when CreatePane fails', () =>
    Effect.gen(function* () {
      const sent: Array<[string, unknown]> = []
      const webContents: EventSender = { send: (channel, payload) => sent.push([channel, payload]) }
      const createError = new WorktreeCreateError({
        paneId: PANE_ID,
        sourceRepo: '/repo',
        cause: 'boom'
      })
      const paneWorkspace = {
        getTree: () => Effect.dieMessage('getTree should not be called'),
        split: () => Effect.dieMessage('split should not be called'),
        createPane: () => Effect.fail(createError),
        close: () => Effect.dieMessage('close should not be called'),
        getPaneHistory: () => Effect.dieMessage('getPaneHistory should not be called')
      }
      const paneSupervisor = {
        openPane: () => Effect.dieMessage('openPane should not be called'),
        closePane: () => Effect.dieMessage('closePane should not be called'),
        getHandle: () => Effect.dieMessage('getHandle should not be called'),
        closeAll: () => Effect.dieMessage('closeAll should not be called')
      }

      yield* Effect.gen(function* () {
        yield* Effect.fork(wireCommands({ paneWorkspace, paneSupervisor, webContents }))
        yield* flush

        emitCommand({
          _tag: 'CreatePane',
          paneId: PANE_ID,
          cwd: '/repo',
          model: 'm',
          useWorktree: false
        })
        yield* flush

        assert.strictEqual(sent.length, 1)
        const [channel, payload] = sent[0]
        assert.strictEqual(channel, CHANNEL.event)
        assert.deepStrictEqual(payload, {
          _tag: 'PaneCreateFailed',
          paneId: PANE_ID,
          reason: String(createError)
        })
      }).pipe(Effect.scoped)
    })
  )

  it.effect('drops SendMessage for an unknown pane without calling sendMessage', () =>
    Effect.gen(function* () {
      const sent: Array<[string, unknown]> = []
      const webContents: EventSender = { send: (channel, payload) => sent.push([channel, payload]) }
      const paneWorkspace = {
        getTree: () => Effect.dieMessage('getTree should not be called'),
        split: () => Effect.dieMessage('split should not be called'),
        createPane: () => Effect.dieMessage('createPane should not be called'),
        close: () => Effect.dieMessage('close should not be called'),
        getPaneHistory: () => Effect.dieMessage('getPaneHistory should not be called')
      }
      const paneSupervisor = {
        openPane: () => Effect.dieMessage('openPane should not be called'),
        closePane: () => Effect.dieMessage('closePane should not be called'),
        getHandle: () => Effect.succeed(Option.none<PaneHandle>()),
        closeAll: () => Effect.dieMessage('closeAll should not be called')
      }

      yield* Effect.gen(function* () {
        yield* Effect.fork(wireCommands({ paneWorkspace, paneSupervisor, webContents }))
        yield* flush

        emitCommand({ _tag: 'SendMessage', paneId: PANE_ID, text: 'hi' })
        yield* flush

        assert.deepStrictEqual(sent, [])
      }).pipe(Effect.scoped)
    })
  )
})
